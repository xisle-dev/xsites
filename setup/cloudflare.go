package main

// Minimal Cloudflare v4 API client -- just the calls setup needs: user API
// tokens (create, update, roll), their permission-group catalog, and R2
// buckets. Tokens are user-owned so the bootstrap credential can be the
// dashboard's stable "Create Additional Tokens" template.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const cfAPI = "https://api.cloudflare.com/client/v4"

// Permission-group scopes, as reported by /user/tokens/permission_groups.
const (
	scopeAccount = "com.cloudflare.api.account"
	scopeZone    = "com.cloudflare.api.account.zone"
	scopeBucket  = "com.cloudflare.edge.r2.bucket"
)

type cloudflare struct {
	token   string
	account string
}

type cfEnvelope struct {
	Success    bool            `json:"success"`
	Errors     []cfError       `json:"errors"`
	Result     json.RawMessage `json:"result"`
	ResultInfo struct {
		TotalPages int `json:"total_pages"`
	} `json:"result_info"`
}

type cfError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// do calls the API and decodes "result" into out (if non-nil). It returns
// the HTTP status so callers can treat a 404 as "doesn't exist".
func (c *cloudflare) do(method, path string, body, out any) (int, *cfEnvelope, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, cfAPI+path, rdr)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	var env cfEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return resp.StatusCode, nil, fmt.Errorf("%s %s: HTTP %d, unreadable body: %v", method, path, resp.StatusCode, err)
	}
	if !env.Success {
		return resp.StatusCode, &env, fmt.Errorf("%s %s: HTTP %d: %v", method, path, resp.StatusCode, env.Errors)
	}
	if out != nil && len(env.Result) > 0 {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return resp.StatusCode, &env, fmt.Errorf("%s %s: decoding result: %v", method, path, err)
		}
	}
	return resp.StatusCode, &env, nil
}

func (c *cloudflare) verify() error {
	var r struct {
		Status string `json:"status"`
	}
	if _, _, err := c.do("GET", "/user/tokens/verify", nil, &r); err != nil {
		return err
	}
	if r.Status != "active" {
		return fmt.Errorf("bootstrap token status is %q, not active", r.Status)
	}
	return nil
}

type permissionGroup struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Scopes []string `json:"scopes"`
}

type permissionCatalog []permissionGroup

func (c *cloudflare) permissionGroups() (permissionCatalog, error) {
	var groups permissionCatalog
	_, _, err := c.do("GET", "/user/tokens/permission_groups", nil, &groups)
	return groups, err
}

// lookup resolves group names to {id,name} refs within one scope. Cloudflare
// renames groups now and then, so an unknown name fails loudly with the
// closest candidates instead of silently creating a weaker token.
func (cat permissionCatalog) lookup(scope string, names ...string) ([]map[string]string, error) {
	var refs []map[string]string
	for _, name := range names {
		found := false
		for _, g := range cat {
			if g.Name == name && contains(g.Scopes, scope) {
				refs = append(refs, map[string]string{"id": g.ID, "name": g.Name})
				found = true
				break
			}
		}
		if !found {
			var similar []string
			word := strings.Fields(name)[0]
			for _, g := range cat {
				if contains(g.Scopes, scope) && strings.Contains(g.Name, word) {
					similar = append(similar, g.Name)
				}
			}
			return nil, fmt.Errorf("permission group %q (scope %s) not found; similar: %v", name, scope, similar)
		}
	}
	return refs, nil
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

type tokenPolicy struct {
	Effect           string              `json:"effect"`
	Resources        map[string]any      `json:"resources"`
	PermissionGroups []map[string]string `json:"permission_groups"`
}

type apiToken struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Value string `json:"value,omitempty"`
}

// ensureToken creates the named token, or -- if one by that name already
// exists -- resets its policies and rolls its secret value. Either way it
// returns a fresh value, since Cloudflare only ever shows a value once.
func (c *cloudflare) ensureToken(name string, policies []tokenPolicy) (apiToken, error) {
	body := map[string]any{"name": name, "policies": policies}
	existing, err := c.findToken(name)
	if err != nil {
		return apiToken{}, err
	}
	if existing == nil {
		var t apiToken
		_, _, err := c.do("POST", "/user/tokens", body, &t)
		return t, err
	}
	if _, _, err := c.do("PUT", "/user/tokens/"+existing.ID, body, nil); err != nil {
		return apiToken{}, err
	}
	var value string
	if _, _, err := c.do("PUT", "/user/tokens/"+existing.ID+"/value", map[string]any{}, &value); err != nil {
		return apiToken{}, err
	}
	return apiToken{ID: existing.ID, Name: name, Value: value}, nil
}

func (c *cloudflare) deleteToken(id string) error {
	_, _, err := c.do("DELETE", "/user/tokens/"+id, nil, nil)
	return err
}

func (c *cloudflare) findToken(name string) (*apiToken, error) {
	for page := 1; ; page++ {
		var tokens []apiToken
		_, env, err := c.do("GET", fmt.Sprintf("/user/tokens?per_page=50&page=%d", page), nil, &tokens)
		if err != nil {
			return nil, err
		}
		for _, t := range tokens {
			if t.Name == name {
				return &t, nil
			}
		}
		if page >= env.ResultInfo.TotalPages {
			return nil, nil
		}
	}
}

// ensureBucket creates an R2 bucket unless it already exists. A token
// minted moments earlier can take a few seconds to become valid, so auth
// failures are retried briefly.
func (c *cloudflare) ensureBucket(name string) (created bool, err error) {
	path := fmt.Sprintf("/accounts/%s/r2/buckets/%s", c.account, name)
	for attempt := 0; ; attempt++ {
		status, env, err := c.do("GET", path, nil, nil)
		if err == nil {
			return false, nil
		}
		if status == http.StatusNotFound {
			break
		}
		if (status == http.StatusUnauthorized || status == http.StatusForbidden || authError(env)) && attempt < 6 {
			time.Sleep(5 * time.Second)
			continue
		}
		return false, err
	}
	_, _, err = c.do("POST", fmt.Sprintf("/accounts/%s/r2/buckets", c.account), map[string]string{"name": name}, nil)
	return err == nil, err
}

// authError reports Cloudflare's "Authentication error" (code 10000), which
// a just-created token returns until it has propagated.
func authError(env *cfEnvelope) bool {
	if env == nil {
		return false
	}
	for _, e := range env.Errors {
		if e.Code == 10000 {
			return true
		}
	}
	return false
}
