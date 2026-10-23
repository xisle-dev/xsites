// setup recreates every piece of xsites' Cloudflare + GitHub configuration,
// for both environments (QA and PROD), from the APIs -- nothing has to be
// clicked through a dashboard except the two bootstrap credentials no API
// can mint for you:
//
//	CLOUDFLARE_BOOTSTRAP_TOKEN  a Cloudflare user token from the dashboard's
//	                            "Create Additional Tokens" template
//	GITHUB_TOKEN                optional; falls back to `gh auth token`
//
// Plus CLOUDFLARE_ACCOUNT_ID and, the first time (or to change them),
// ADMIN_PASSWORD_QA and ADMIN_PASSWORD_PROD.
//
// QA and PROD share the account and the code, nothing else: each has its
// own Worker (see server/wrangler.toml), R2 bucket, admin password,
// Cloudflare tokens and GitHub environment. Per environment, in order:
//
//  1. The R2 bucket, created by a temporary token deleted straight after
//  2. Token "xsites-deploy-<env>": Workers scripts, routes, DNS -- no R2
//  3. Token "xsites-r2-<env>": object read/write on that env's bucket only
//  4. GitHub environment <env> (PROD requires your approval to deploy) with
//     secrets CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID,
//     R2_SECRET_ACCESS_KEY, ADMIN_PASSWORD and variable R2_BUCKET
//
// Then, for backups: GitHub environment "prod-backup" holding a read-only
// token on PROD's bucket. Backups are committed to this repo's "backup"
// branch with the workflow's own GITHUB_TOKEN, so no keys are needed.
//
// Every step is safe to re-run. Re-running rotates every token value and
// writes the new ones into GitHub, so nothing goes stale.
//
// Usage:
//
//	cd setup
//	go run . [-repo xisle-dev/xsites] [-deploy]
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
)

type environment struct {
	name        string // GitHub environment and token suffix
	bucket      string // must match server/wrangler.toml
	passwordEnv string
	approval    bool // deploys wait for the repo owner's approval
}

var environments = []environment{
	{name: "qa", bucket: "xsites-qa", passwordEnv: "ADMIN_PASSWORD_QA"},
	{name: "prod", bucket: "xsites-prod", passwordEnv: "ADMIN_PASSWORD_PROD", approval: true},
}

const prodBucket = "xsites-prod"

func main() {
	repo := flag.String("repo", "xisle-dev/xsites", "GitHub repo that deploys the site")
	deploy := flag.Bool("deploy", false, "run the Deploy workflow when setup finishes (QA, then PROD after approval)")
	flag.Parse()
	log.SetFlags(0)

	s := &setup{
		account: mustEnv("CLOUDFLARE_ACCOUNT_ID"),
		cf:      &cloudflare{token: mustEnv("CLOUDFLARE_BOOTSTRAP_TOKEN"), account: os.Getenv("CLOUDFLARE_ACCOUNT_ID")},
		gh:      &github{token: githubToken()},
		repo:    *repo,
	}

	step("Checking credentials")
	check(s.cf.verify())
	var err error
	s.catalog, err = s.cf.permissionGroups()
	check(err)
	s.ownerID, err = s.gh.currentUserID()
	check(err)

	for _, env := range environments {
		s.environment(env)
	}
	s.backups()

	// Only the Update workflow's PRs depend on this, so a refusal is a
	// warning rather than a reason to stop before deploying.
	step("Allowing GitHub Actions to open pull requests")
	if err := s.gh.allowActionsPRs(s.repo); err != nil {
		fmt.Println("    WARNING: " + err.Error())
		fmt.Println("    Everything else is set up; only the Update workflow's pull requests need this.")
	}

	if *deploy {
		step("Running the Deploy workflow")
		branch, err := s.gh.defaultBranch(s.repo)
		check(err)
		check(s.gh.dispatch(s.repo, "deploy.yml", branch))
		fmt.Printf("    QA deploys now; PROD waits for your approval: https://github.com/%s/actions/workflows/deploy.yml\n", s.repo)
	}

	fmt.Println("\nDone.")
	if !*deploy {
		fmt.Println("Next: push to the default branch, or re-run with -deploy, to deploy.")
	}
}

type setup struct {
	account string
	cf      *cloudflare
	gh      *github
	catalog permissionCatalog
	ownerID int64
	repo    string
}

func (s *setup) environment(env environment) {
	scope := envScope(s.repo, env.name)
	step(fmt.Sprintf("[%s] GitHub environment", env.name))
	var reviewer int64
	if env.approval {
		reviewer = s.ownerID
	}
	check(s.gh.ensureEnvironment(s.repo, env.name, reviewer))

	s.createBucket(env.name, env.bucket)

	step(fmt.Sprintf("[%s] Cloudflare token xsites-deploy-%s", env.name, env.name))
	accountRefs, err := s.catalog.lookup(scopeAccount, "Workers Scripts Write", "Account Settings Read", "Workers Tail Read")
	check(err)
	zoneRefs, err := s.catalog.lookup(scopeZone, "Workers Routes Write", "Zone Read", "DNS Write")
	check(err)
	deployTok, err := s.cf.ensureToken("xsites-deploy-"+env.name, []tokenPolicy{
		{Effect: "allow", Resources: map[string]any{s.accountRes(): "*"}, PermissionGroups: accountRefs},
		{Effect: "allow", Resources: map[string]any{s.accountRes(): map[string]string{"com.cloudflare.api.account.zone.*": "*"}}, PermissionGroups: zoneRefs},
	})
	check(err)

	step(fmt.Sprintf("[%s] Cloudflare token xsites-r2-%s", env.name, env.name))
	keyID, secret := s.r2Token("xsites-r2-"+env.name, "Workers R2 Storage Bucket Item Write", env.bucket)

	step(fmt.Sprintf("[%s] GitHub secrets and variables", env.name))
	check(s.gh.setSecret(scope, "CLOUDFLARE_API_TOKEN", deployTok.Value))
	check(s.gh.setSecret(scope, "CLOUDFLARE_ACCOUNT_ID", s.account))
	check(s.gh.setSecret(scope, "R2_ACCESS_KEY_ID", keyID))
	check(s.gh.setSecret(scope, "R2_SECRET_ACCESS_KEY", secret))
	check(s.gh.setVariable(scope, "R2_BUCKET", env.bucket))
	if pw := os.Getenv(env.passwordEnv); pw != "" {
		check(s.gh.setSecret(scope, "ADMIN_PASSWORD", pw))
	} else if ok, err := s.gh.secretExists(scope, "ADMIN_PASSWORD"); err != nil {
		check(err)
	} else if !ok {
		log.Fatalf("%s is not set here or in GitHub yet; set it for the first run", env.passwordEnv)
	} else {
		fmt.Println("    (ADMIN_PASSWORD unchanged)")
	}
}

// createBucket creates the environment's R2 bucket with a short-lived token
// that has account-wide R2 rights, deleted as soon as it's done, so no
// long-lived credential can reach another environment's bucket.
func (s *setup) createBucket(env, name string) {
	refs, err := s.catalog.lookup(scopeAccount, "Workers R2 Storage Write")
	check(err)
	tmp, err := s.cf.ensureToken("xsites-setup-"+env, []tokenPolicy{
		{Effect: "allow", Resources: map[string]any{s.accountRes(): "*"}, PermissionGroups: refs},
	})
	check(err)
	defer func() { check(s.cf.deleteToken(tmp.ID)) }()
	creator := &cloudflare{token: tmp.Value, account: s.account}
	step(fmt.Sprintf("[%s] R2 bucket %s", env, name))
	created, err := creator.ensureBucket(name)
	check(err)
	done(created, "created", "already exists")
}

// r2Token ensures a token with one bucket-level permission on the given
// buckets and returns it as R2 S3 credentials: the access key ID is the
// token's id, the secret is the SHA-256 of its value.
func (s *setup) r2Token(name, permission string, buckets ...string) (keyID, secret string) {
	refs, err := s.catalog.lookup(scopeBucket, permission)
	check(err)
	res := map[string]any{}
	for _, b := range buckets {
		res[fmt.Sprintf("com.cloudflare.edge.r2.bucket.%s_default_%s", s.account, b)] = "*"
	}
	tok, err := s.cf.ensureToken(name, []tokenPolicy{{Effect: "allow", Resources: res, PermissionGroups: refs}})
	check(err)
	sum := sha256.Sum256([]byte(tok.Value))
	return tok.ID, hex.EncodeToString(sum[:])
}

func (s *setup) backups() {
	scope := envScope(s.repo, "prod-backup")
	step("[backup] GitHub environment prod-backup")
	check(s.gh.ensureEnvironment(s.repo, "prod-backup", 0))

	step("[backup] Cloudflare token xsites-backup-read (read-only, PROD bucket)")
	keyID, secret := s.r2Token("xsites-backup-read", "Workers R2 Storage Bucket Item Read", prodBucket)
	check(s.gh.setSecret(scope, "CLOUDFLARE_ACCOUNT_ID", s.account))
	check(s.gh.setSecret(scope, "R2_ACCESS_KEY_ID", keyID))
	check(s.gh.setSecret(scope, "R2_SECRET_ACCESS_KEY", secret))
}

func (s *setup) accountRes() string { return "com.cloudflare.api.account." + s.account }

func githubToken() string {
	if t := os.Getenv("GITHUB_TOKEN"); t != "" {
		return t
	}
	out, err := exec.Command("gh", "auth", "token").Output()
	if err != nil {
		log.Fatal("GITHUB_TOKEN is not set and `gh auth token` failed; run `gh auth login` or set GITHUB_TOKEN")
	}
	return strings.TrimSpace(string(out))
}

func mustEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		log.Fatalf("%s is not set; see the comment at the top of setup/main.go", name)
	}
	return v
}

func step(msg string) { fmt.Println("==> " + msg) }

func done(changed bool, yes, no string) {
	if changed {
		fmt.Println("    " + yes)
	} else {
		fmt.Println("    " + no)
	}
}

func check(err error) {
	if err != nil {
		log.Fatal("error: ", err)
	}
}
