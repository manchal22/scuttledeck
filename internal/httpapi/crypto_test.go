package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func sign(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestVerifyGithubSignature(t *testing.T) {
	secret := "s3cret"
	body := `{"hello":"world"}`
	good := sign(secret, body)

	if !VerifyGithubSignature(secret, []byte(body), good) {
		t.Error("valid signature rejected")
	}
	if VerifyGithubSignature(secret, []byte(body+" "), good) {
		t.Error("tampered body accepted")
	}
	if VerifyGithubSignature(secret, []byte(body), sign("other", body)) {
		t.Error("wrong secret accepted")
	}
	if VerifyGithubSignature(secret, []byte(body), "") {
		t.Error("missing header accepted")
	}
	if VerifyGithubSignature(secret, []byte(body), "sha1=abc") {
		t.Error("sha1 header accepted")
	}
	if VerifyGithubSignature(secret, []byte(body), "sha256=zz") {
		t.Error("malformed hex accepted")
	}
}

func TestSha256Hex(t *testing.T) {
	if Sha256Hex("token") != Sha256Hex("token") {
		t.Error("not deterministic")
	}
	if len(Sha256Hex("token")) != 64 {
		t.Error("wrong length")
	}
}
