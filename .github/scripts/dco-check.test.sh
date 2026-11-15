#!/usr/bin/env bash
# Proof that dco-check.sh discriminates. A gate that only ever prints green is indistinguishable
# from one that stopped checking, so every case below pairs a pass with the failure that must
# accompany it. Builds a throwaway repository sized past the limit that broke the old gate: forty
# commits, each carrying a ten-kilobyte message, so the commit list is far larger than the 128 KiB
# argument ceiling that used to crash the check before it evaluated anything.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; check="$here/dco-check.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"; git init -q -b main .
export GIT_AUTHOR_NAME="Ada Example" GIT_AUTHOR_EMAIL="ada@example.org"
export GIT_COMMITTER_NAME="Ada Example" GIT_COMMITTER_EMAIL="ada@example.org"
pad="$(head -c 10240 /dev/zero | tr '\0' 'x')"

commit() { # commit <file> <message-body...>
  local f="$1"; shift; echo "$RANDOM" >> "$f"; git add "$f"; git commit -q -m "$@"; }
signed()   { commit "$1" "$2" -m "$pad" -m "Signed-off-by: ${GIT_AUTHOR_NAME} <${GIT_AUTHOR_EMAIL}>"; }
unsigned() { commit "$1" "$2" -m "$pad"; }

commit base "base"; base=$(git rev-parse HEAD)
git checkout -q -b topic
for i in $(seq 1 38); do signed a "signed $i"; done
# a two-parent merge without a sign-off, the shape GitHub's merge button produces
git checkout -q -b side; signed s "side work"; git checkout -q topic; git merge -q --no-ff --no-edit side
# a bot commit without a sign-off
BOT="49699333+dependabot[bot]@users.noreply.github.com"
GIT_AUTHOR_NAME="dependabot[bot]" GIT_AUTHOR_EMAIL="$BOT" unsigned b "bump a dependency"
good=$(git rev-parse HEAD)
bytes=$(git log --format=%B "${base}..${good}" | wc -c)
[ "$bytes" -gt 131072 ] || { echo "FAIL: fixture too small to exercise the size case (${bytes} bytes)"; exit 1; }

pass=0; fail=0
EXEMPT="" # the author email the workflow exempts, set only for a pull request the dependency bot opened
expect() { # expect <label> <exit-code> <base> <head> [grep-for-in-output]
  local label="$1" want="$2" b="$3" h="$4" needle="${5:-}"; local out rc=0
  out=$(env ${EXEMPT:+DCO_EXEMPT_AUTHOR_EMAIL="$EXEMPT"} bash "$check" "$b" "$h" 2>&1) || rc=$?
  if [ "$rc" -ne "$want" ]; then echo "FAIL: $label — exit $rc, wanted $want"; echo "$out" | tail -3; fail=$((fail+1)); return; fi
  if [ -n "$needle" ] && ! grep -qF -- "$needle" <<<"$out"; then echo "FAIL: $label — output lacks '$needle'"; echo "$out" | tail -3; fail=$((fail+1)); return; fi
  echo "ok: $label"; pass=$((pass+1)); }

EXEMPT="$BOT"
expect "39 signed + 1 merge + 1 bot, ${bytes} bytes of messages: passes" 0 "$base" "$good" "39 commit(s) evaluated, 1 clean merge(s) exempt, 1 bot commit(s) exempt, 0 failure(s)"
# the exemption is that one email, never "any bot-shaped author"
git checkout -q -b otherbot "$good"; GIT_AUTHOR_NAME="other[bot]" GIT_AUTHOR_EMAIL="1+other[bot]@users.noreply.github.com" unsigned g "another bot"
expect "a different bot-shaped author, unsigned: fails" 1 "$base" "$(git rev-parse HEAD)" "\"another bot\": the sign-off is missing"
# with no exemption set, a commit that merely claims a bot author is checked like any other
EXEMPT=""
expect "bot-shaped author on a pull request the bot did not open: fails" 1 "$base" "$good" "\"bump a dependency\": the sign-off is missing"
EXEMPT="$BOT" # the remaining cases build on the range above, bot commit included

# one unsigned human commit in the middle of a large range must fail and be named
git checkout -q -b bad1 "$good"; unsigned c "forgot to sign"; culprit=$(git rev-parse --short=12 HEAD); for i in $(seq 1 5); do signed a "after $i"; done
expect "one missing sign-off among 45 commits: fails naming it" 1 "$base" "$(git rev-parse HEAD)" "${culprit} \"forgot to sign\": the sign-off is missing"

# a sign-off that names someone else must fail
git checkout -q -b bad2 "$good"; commit d "signed by a stranger" -m "Signed-off-by: Someone Else <else@example.org>"
expect "sign-off with a different name and email: fails" 1 "$base" "$(git rev-parse HEAD)" "expected \"Ada Example <ada@example.org>\", got \"Someone Else <else@example.org>\""

# name and email are matched case-insensitively, and a committer's identity is acceptable
git checkout -q -b ok2 "$good"; commit e "signed in upper case" -m "Signed-off-by: ADA EXAMPLE <ADA@EXAMPLE.ORG>"
expect "case-insensitive match: passes" 0 "$base" "$(git rev-parse HEAD)"

# merge commits stay exempt: an unsigned two-parent commit alone must not fail
git checkout -q -b m2 "$good"; git checkout -q -b side2; signed t "more side work"; git checkout -q m2; git merge -q --no-ff --no-edit side2
expect "unsigned clean merge commit: exempt, passes" 0 "$good" "$(git rev-parse HEAD)" "1 clean merge(s) exempt"

# a merge that carries changes of its own is not exempt: here a file is folded into the merge commit
git checkout -q -b evil "$good"; git checkout -q -b side3; signed u "side three"; git checkout -q evil
git merge -q --no-ff --no-commit side3 >/dev/null 2>&1; echo smuggled > smuggled; git add smuggled; git commit -q --no-edit
expect "unsigned merge with a change of its own: fails" 1 "$good" "$(git rev-parse HEAD)" "the sign-off is missing"

# a merge that resolved a conflict is checked: unsigned fails, signed by its author passes
sign="Signed-off-by: ${GIT_AUTHOR_NAME} <${GIT_AUTHOR_EMAIL}>"
git checkout -q -b c1 "$good"; echo one > clash; git add clash; git commit -q -m "one side" -m "$sign"
git checkout -q -b c2 "$good"; echo two > clash; git add clash; git commit -q -m "other side" -m "$sign"
git checkout -q c1; git merge -q --no-ff c2 -m "resolve the clash" >/dev/null 2>&1 && { echo "FAIL: the fixture merged without a conflict"; exit 1; }
echo resolved > clash; git add clash; git commit -q --no-edit
expect "unsigned conflict-resolving merge: fails" 1 "$good" "$(git rev-parse HEAD)" "the sign-off is missing"
git commit -q --amend -s --no-edit
expect "signed conflict-resolving merge: passes" 0 "$good" "$(git rev-parse HEAD)"

# a merge of three parents is checked like any other commit
git checkout -q -b oct "$good"; git checkout -q -b o1; signed o1 "o one"; git checkout -q -b o2 "$good"; signed o2 "o two"
git checkout -q oct; git merge -q --no-ff --no-edit o1 o2 >/dev/null
[ "$(git rev-list --parents -n 1 HEAD | wc -w)" -eq 4 ] || { echo "FAIL: the octopus fixture does not have three parents"; exit 1; }
expect "unsigned octopus merge: fails" 1 "$good" "$(git rev-parse HEAD)" "the sign-off is missing"

# and the exemption is exactly two-parent, not "has the word merge in it": a single-parent commit
# titled like a merge is still checked
git checkout -q -b fake "$good"; unsigned f "Merge branch 'nothing'"
expect "single-parent commit titled Merge: still checked, fails" 1 "$base" "$(git rev-parse HEAD)" "the sign-off is missing"

# a dependency-bot commit that GitHub made and signed is exempt on any pull request, release ones
# included. A throwaway key stands in for GitHub's; every field and the signature must hold.
export GNUPGHOME="$tmp/gnupg"; mkdir -m 700 "$GNUPGHOME"
newkey() { gpg --batch --quiet --passphrase '' --quick-gen-key "$1" ed25519 sign never 2>/dev/null
  gpg --list-keys --with-colons "$1" 2>/dev/null | awk -F: '/^fpr/{print $10; exit}'; }
gh_fpr=$(newkey "GitHub Stand-in <noreply@github.com>"); other_fpr=$(newkey "Not GitHub <x@example.org>")
# the key file holds a second key, as GitHub's published file does: only the pinned fingerprint counts
gpg --armor --export "$gh_fpr" "$other_fpr" > "$tmp/github.asc"
export DCO_GITHUB_KEY="$tmp/github.asc" DCO_GITHUB_FPR="$gh_fpr"
bump() { # bump <branch> <signing-key-or-empty> <committer-name> <committer-email> <subject>
  git checkout -q -b "$1" "$good"; echo "$RANDOM" >> deps; git add deps
  GIT_AUTHOR_NAME="dependabot[bot]" GIT_AUTHOR_EMAIL="$BOT" GIT_COMMITTER_NAME="$3" GIT_COMMITTER_EMAIL="$4" \
    git -c user.signingkey="${2:-none}" commit -q ${2:+-S} -m "$5" -m "Signed-off-by: dependabot[bot] <support@github.com>"; }
EXEMPT=""
bump gh1 "$gh_fpr" GitHub noreply@github.com "bump, made by GitHub"
expect "bot commit signed with GitHub's key, on a pull request the bot did not open: exempt" 0 "$good" "$(git rev-parse HEAD)" "1 bot commit(s) exempt, 0 failure(s)"
bump gh2 "" GitHub noreply@github.com "bump, unsigned"
expect "the same bot commit without a signature: fails" 1 "$good" "$(git rev-parse HEAD)" "\"bump, unsigned\": expected"
bump gh3 "$other_fpr" GitHub noreply@github.com "bump, another key"
expect "the same bot commit signed with another key in the key file: fails" 1 "$good" "$(git rev-parse HEAD)" "\"bump, another key\": expected"
bump gh4 "$gh_fpr" "Ada Example" ada@example.org "bump, not committed by GitHub"
expect "signed with GitHub's key but committed by someone else: fails" 1 "$good" "$(git rev-parse HEAD)" "\"bump, not committed by GitHub\": expected"
git checkout -q -b gh5 "$good"; echo "$RANDOM" >> deps; git add deps
GIT_COMMITTER_NAME=GitHub GIT_COMMITTER_EMAIL=noreply@github.com git -c user.signingkey="$gh_fpr" commit -q -S -m "a person's commit, signed with GitHub's key"
expect "GitHub's signature on a commit the bot did not author: still needs a sign-off, fails" 1 "$good" "$(git rev-parse HEAD)" "the sign-off is missing"
unset DCO_GITHUB_KEY DCO_GITHUB_FPR GNUPGHOME
EXEMPT="$BOT"

# the real commit this exemption was written for: the dependency bot's tooling update, signed by
# GitHub, checked with the key and fingerprint the checker ships with
repo="$(git -C "$here" rev-parse --show-toplevel)"
real=ac4977f4f0a5
if git -C "$repo" cat-file -e "${real}^{commit}" 2>/dev/null; then
  cd "$repo"; EXEMPT=""
  expect "ac4977f, the bot's tooling update signed by GitHub: exempt" 0 "${real}^" "$real" "1 bot commit(s) exempt, 0 failure(s)"
  cd "$tmp"; EXEMPT="$BOT"
else
  echo "FAIL: ${real} is not in this checkout; the workflow fetches all history"; fail=$((fail+1))
fi

# an empty range is the gate failing to run, never a pass
expect "empty range: exit 2, not a pass" 2 "$good" "$good" "no commits in"

echo "dco-check.test.sh: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
