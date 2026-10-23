package main

// Minimal GitHub REST client for setup: environments, Actions secrets and
// variables, the Actions PR-creation setting, and workflow dispatch.

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

// A scope is where Actions secrets and variables live: the whole repo, or
// one deployment environment of it.
func repoScope(repo string) string { return "/repos/" + repo + "/actions" }

func envScope(repo, env string) string { return "/repos/" + repo + "/environments/" + env }

// setSecret encrypts value with the scope's public key (libsodium sealed
// box, as GitHub requires) and creates or replaces the secret.
func (g *github) setSecret(scope, name, value string) error {
	var pk struct {
		KeyID string `json:"key_id"`
		Key   string `json:"key"`
	}
	if _, err := g.do("GET", scope+"/secrets/public-key", nil, &pk); err != nil {
		return err
	}
	raw, err := base64.StdEncoding.DecodeString(pk.Key)
	if err != nil || len(raw) != 32 {
		return fmt.Errorf("unexpected Actions public key for %s", scope)
	}
	var recipient [32]byte
	copy(recipient[:], raw)
	sealed, err := box.SealAnonymous(nil, []byte(value), &recipient, rand.Reader)
	if err != nil {
		return err
	}
	_, err = g.do("PUT", scope+"/secrets/"+name, map[string]string{
		"encrypted_value": base64.StdEncoding.EncodeToString(sealed),
		"key_id":          pk.KeyID,
	}, nil)
	return err
}

func (g *github) secretExists(scope, name string) (bool, error) {
	status, err := g.do("GET", scope+"/secrets/"+name, nil, nil)
	if status == http.StatusNotFound {
		return false, nil
	}
	return err == nil, err
}

func (g *github) setVariable(scope, name, value string) error {
	body := map[string]string{"name": name, "value": value}
	status, err := g.do("PATCH", scope+"/variables/"+name, body, nil)
	if status == http.StatusNotFound {
		_, err = g.do("POST", scope+"/variables", body, nil)
	}
	return err
}

// ensureEnvironment creates or updates a deployment environment. With a
// reviewer, every job that targets it waits for that user's approval.
func (g *github) ensureEnvironment(repo, env string, reviewerID int64) error {
	body := map[string]any{}
	if reviewerID != 0 {
		body["reviewers"] = []map[string]any{{"type": "User", "id": reviewerID}}
	}
	_, err := g.do("PUT", envScope(repo, env), body, nil)
	return err
}

func (g *github) currentUserID() (int64, error) {
	var u struct {
		ID int64 `json:"id"`
	}
	_, err := g.do("GET", "/user", nil, &u)
	return u.ID, err
}

// allowActionsPRs turns on "Allow GitHub Actions to create and approve pull
// requests", which the Airspace workflow needs. For an org-owned repo the
// org's own setting has to allow it first, so when the repo-level call is
// refused for that reason (409) it's turned on at the org level too -- that
// needs the admin:org scope, which `gh auth login` doesn't grant by default.
func (g *github) allowActionsPRs(repo string) error {
	body := map[string]any{
		"default_workflow_permissions":     "read",
		"can_approve_pull_request_reviews": true,
	}
	status, err := g.do("PUT", "/repos/"+repo+"/actions/permissions/workflow", body, nil)
	if status != http.StatusConflict {
		return err
	}
	org, _, _ := strings.Cut(repo, "/")
	status, err = g.do("PUT", "/orgs/"+org+"/actions/permissions/workflow", body, nil)
	if status == http.StatusForbidden || status == http.StatusNotFound {
		return fmt.Errorf("the %s org blocks Actions from opening pull requests, and this GitHub token can't change org settings; "+
			"run `gh auth refresh -h github.com -s admin:org` and re-run setup, or enable it under the org's Settings > Actions > General", org)
	}
	if err != nil {
		return err
	}
	_, err = g.do("PUT", "/repos/"+repo+"/actions/permissions/workflow", body, nil)
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
