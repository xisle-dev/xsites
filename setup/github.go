package main

// Minimal GitHub REST client for setup: Actions secrets and variables, the
// private backup repo and its deploy key, the Actions PR-creation setting,
// and workflow dispatch.

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"golang.org/x/crypto/nacl/box"
)

const ghAPI = "https://api.github.com"

type github struct {
	token string
}

// do calls the API and decodes the JSON response into out (if non-nil).
// Any status >= 300 is an error, but the status is returned so callers can
// treat a 404 as "doesn't exist".
func (g *github) do(method, path string, body, out any) (int, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, ghAPI+path, rdr)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+g.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("%s %s: HTTP %d: %s", method, path, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, fmt.Errorf("%s %s: decoding response: %v", method, path, err)
		}
	}
	return resp.StatusCode, nil
}

// setSecret encrypts value with the repo's Actions public key (libsodium
// sealed box, as GitHub requires) and creates or replaces the secret.
func (g *github) setSecret(repo, name, value string) error {
	var pk struct {
		KeyID string `json:"key_id"`
		Key   string `json:"key"`
	}
	if _, err := g.do("GET", "/repos/"+repo+"/actions/secrets/public-key", nil, &pk); err != nil {
		return err
	}
	raw, err := base64.StdEncoding.DecodeString(pk.Key)
	if err != nil || len(raw) != 32 {
		return fmt.Errorf("unexpected Actions public key for %s", repo)
	}
	var recipient [32]byte
	copy(recipient[:], raw)
	sealed, err := box.SealAnonymous(nil, []byte(value), &recipient, rand.Reader)
	if err != nil {
		return err
	}
	_, err = g.do("PUT", "/repos/"+repo+"/actions/secrets/"+name, map[string]string{
		"encrypted_value": base64.StdEncoding.EncodeToString(sealed),
		"key_id":          pk.KeyID,
	}, nil)
	return err
}

func (g *github) secretExists(repo, name string) (bool, error) {
	status, err := g.do("GET", "/repos/"+repo+"/actions/secrets/"+name, nil, nil)
	if status == http.StatusNotFound {
		return false, nil
	}
	return err == nil, err
}

func (g *github) setVariable(repo, name, value string) error {
	body := map[string]string{"name": name, "value": value}
	status, err := g.do("PATCH", "/repos/"+repo+"/actions/variables/"+name, body, nil)
	if status == http.StatusNotFound {
		_, err = g.do("POST", "/repos/"+repo+"/actions/variables", body, nil)
	}
	return err
}

// ensurePrivateRepo creates owner/name as a private repo (with an initial
// commit, so Actions can check it out) unless it already exists.
func (g *github) ensurePrivateRepo(full string) (created bool, err error) {
	status, err := g.do("GET", "/repos/"+full, nil, nil)
	if err == nil {
		return false, nil
	}
	if status != http.StatusNotFound {
		return false, err
	}
	owner, name, _ := strings.Cut(full, "/")
	var user struct {
		Type string `json:"type"`
	}
	if _, err := g.do("GET", "/users/"+owner, nil, &user); err != nil {
		return false, err
	}
	path := "/user/repos"
	if user.Type == "Organization" {
		path = "/orgs/" + owner + "/repos"
	}
	_, err = g.do("POST", path, map[string]any{
		"name":        name,
		"private":     true,
		"auto_init":   true,
		"description": "Nightly backup of the xsites live data (R2 xsites-live-data)",
	}, nil)
	return err == nil, err
}

// replaceDeployKey removes any deploy key with this title and adds pub as a
// new write-enabled one.
func (g *github) replaceDeployKey(repo, title, pub string) error {
	var keys []struct {
		ID    int64  `json:"id"`
		Title string `json:"title"`
	}
	if _, err := g.do("GET", "/repos/"+repo+"/keys", nil, &keys); err != nil {
		return err
	}
	for _, k := range keys {
		if k.Title == title {
			if _, err := g.do("DELETE", fmt.Sprintf("/repos/%s/keys/%d", repo, k.ID), nil, nil); err != nil {
				return err
			}
		}
	}
	_, err := g.do("POST", "/repos/"+repo+"/keys", map[string]any{
		"title": title, "key": pub, "read_only": false,
	}, nil)
	return err
}

// allowActionsPRs turns on "Allow GitHub Actions to create and approve pull
// requests", which the Airspace workflow needs. An org-level policy can
// still override this for org-owned repos.
func (g *github) allowActionsPRs(repo string) error {
	_, err := g.do("PUT", "/repos/"+repo+"/actions/permissions/workflow", map[string]any{
		"default_workflow_permissions":     "read",
		"can_approve_pull_request_reviews": true,
	}, nil)
	return err
}

func (g *github) defaultBranch(repo string) (string, error) {
	var r struct {
		DefaultBranch string `json:"default_branch"`
	}
	_, err := g.do("GET", "/repos/"+repo, nil, &r)
	return r.DefaultBranch, err
}

func (g *github) dispatch(repo, workflow, ref string) error {
	_, err := g.do("POST", "/repos/"+repo+"/actions/workflows/"+workflow+"/dispatches", map[string]string{"ref": ref}, nil)
	return err
}
