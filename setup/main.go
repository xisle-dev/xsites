// setup recreates every piece of xsites' Cloudflare + GitHub configuration
// from the APIs, so nothing has to be clicked through a dashboard except
// the two bootstrap credentials no API can mint for you:
//
//	CLOUDFLARE_BOOTSTRAP_TOKEN  a Cloudflare user token from the dashboard's
//	                            "Create Additional Tokens" template
//	GITHUB_TOKEN                optional; falls back to `gh auth token`
//
// Plus CLOUDFLARE_ACCOUNT_ID and, the first time (or to change it),
// ADMIN_PASSWORD.
//
// What it does, in order -- every step is safe to re-run:
//
//  1. Cloudflare token "xsites-deploy" (Edit Cloudflare Workers equivalent)
//  2. R2 buckets xsites and xsites-live-data, created with that token
//  3. Cloudflare token "xsites-r2" (object read/write on those two buckets),
//     converted to R2 S3 credentials
//  4. Repo secrets CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
//     R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, ADMIN_PASSWORD
//  5. Private backup repo, a fresh SSH deploy key on it, secret
//     BACKUP_DEPLOY_KEY and variable BACKUP_REPO
//  6. "Allow GitHub Actions to create and approve pull requests"
//  7. With -deploy: runs the Deploy workflow
//
// Re-running rotates both Cloudflare token values and the deploy key, and
// writes the new values straight into GitHub, so nothing goes stale.
//
// Usage:
//
//	cd setup
//	go run . [-repo xisle-dev/xsites] [-backup-repo xisle-dev/xsites-backup] [-deploy]
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"

	"golang.org/x/crypto/ssh"
)

var buckets = []string{"xsites", "xsites-live-data"}

func main() {
	repo := flag.String("repo", "xisle-dev/xsites", "GitHub repo that deploys the site")
	backupRepo := flag.String("backup-repo", "xisle-dev/xsites-backup", "private GitHub repo the nightly backup commits to")
	deploy := flag.Bool("deploy", false, "run the Deploy workflow when setup finishes")
	flag.Parse()
	log.SetFlags(0)

	account := mustEnv("CLOUDFLARE_ACCOUNT_ID")
	cfBoot := &cloudflare{token: mustEnv("CLOUDFLARE_BOOTSTRAP_TOKEN"), account: account}
	gh := &github{token: githubToken()}

	step("Checking the Cloudflare bootstrap token")
	check(cfBoot.verify())
	catalog, err := cfBoot.permissionGroups()
	check(err)

	step("Cloudflare token xsites-deploy")
	accountRefs, err := catalog.lookup(scopeAccount,
		"Workers Scripts Write", "Workers R2 Storage Write", "Workers KV Storage Write",
		"Account Settings Read", "Workers Tail Read")
	check(err)
	zoneRefs, err := catalog.lookup(scopeZone, "Workers Routes Write", "Zone Read", "DNS Write")
	check(err)
	accountRes := "com.cloudflare.api.account." + account
	deployTok, err := cfBoot.ensureToken("xsites-deploy", []tokenPolicy{
		{Effect: "allow", Resources: map[string]any{accountRes: "*"}, PermissionGroups: accountRefs},
		{Effect: "allow", Resources: map[string]any{accountRes: map[string]string{"com.cloudflare.api.account.zone.*": "*"}}, PermissionGroups: zoneRefs},
	})
	check(err)

	cfDeploy := &cloudflare{token: deployTok.Value, account: account}
	for _, b := range buckets {
		step("R2 bucket " + b)
		created, err := cfDeploy.ensureBucket(b)
		check(err)
		done(created, "created", "already exists")
	}

	step("Cloudflare token xsites-r2")
	bucketRefs, err := catalog.lookup(scopeBucket, "Workers R2 Storage Bucket Item Write")
	check(err)
	bucketRes := map[string]any{}
	for _, b := range buckets {
		bucketRes[fmt.Sprintf("com.cloudflare.edge.r2.bucket.%s_default_%s", account, b)] = "*"
	}
	r2Tok, err := cfBoot.ensureToken("xsites-r2", []tokenPolicy{
		{Effect: "allow", Resources: bucketRes, PermissionGroups: bucketRefs},
	})
	check(err)
	// R2's S3 credentials are derived from an API token: the access key ID
	// is the token's id, the secret is the SHA-256 of its value.
	sum := sha256.Sum256([]byte(r2Tok.Value))
	r2Secret := hex.EncodeToString(sum[:])

	step("GitHub secrets on " + *repo)
	check(gh.setSecret(*repo, "CLOUDFLARE_API_TOKEN", deployTok.Value))
	check(gh.setSecret(*repo, "CLOUDFLARE_ACCOUNT_ID", account))
	check(gh.setSecret(*repo, "R2_ACCESS_KEY_ID", r2Tok.ID))
	check(gh.setSecret(*repo, "R2_SECRET_ACCESS_KEY", r2Secret))
	if pw := os.Getenv("ADMIN_PASSWORD"); pw != "" {
		check(gh.setSecret(*repo, "ADMIN_PASSWORD", pw))
	} else if ok, err := gh.secretExists(*repo, "ADMIN_PASSWORD"); err != nil {
		check(err)
	} else if !ok {
		log.Fatal("ADMIN_PASSWORD is not set here or in GitHub yet; set it for the first run")
	} else {
		fmt.Println("    (ADMIN_PASSWORD unchanged)")
	}

	step("Backup repo " + *backupRepo)
	created, err := gh.ensurePrivateRepo(*backupRepo)
	check(err)
	done(created, "created (private)", "already exists")
	pub, priv := newDeployKey()
	check(gh.replaceDeployKey(*backupRepo, "xsites-backup", pub))
	check(gh.setSecret(*repo, "BACKUP_DEPLOY_KEY", priv))
	check(gh.setVariable(*repo, "BACKUP_REPO", *backupRepo))

	step("Allowing GitHub Actions to open pull requests")
	check(gh.allowActionsPRs(*repo))

	if *deploy {
		step("Running the Deploy workflow")
		branch, err := gh.defaultBranch(*repo)
		check(err)
		check(gh.dispatch(*repo, "deploy.yml", branch))
		fmt.Printf("    started: https://github.com/%s/actions/workflows/deploy.yml\n", *repo)
	}

	fmt.Println("\nDone.")
	if !*deploy {
		fmt.Println("Next: push to the default branch, or re-run with -deploy, to deploy.")
	}
	fmt.Println("First time only: run the Tiles workflow to upload the label tiles to R2.")
}

// newDeployKey returns an ed25519 key pair as an authorized_keys line and an
// OpenSSH private key, the formats GitHub and actions/checkout expect.
func newDeployKey() (pub, priv string) {
	pk, sk, err := ed25519.GenerateKey(rand.Reader)
	check(err)
	sshPub, err := ssh.NewPublicKey(pk)
	check(err)
	block, err := ssh.MarshalPrivateKey(sk, "xsites-backup")
	check(err)
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub))), string(pem.EncodeToMemory(block))
}

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
