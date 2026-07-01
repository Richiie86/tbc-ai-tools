"""Safely inspect MONGO_URL structure WITHOUT revealing the password."""
import os
import re
from urllib.parse import urlsplit, unquote

uri = os.environ.get("MONGO_URL", "")
if not uri:
    print("MONGO_URL is EMPTY / not set")
    raise SystemExit(0)

scheme = uri.split("://", 1)[0] if "://" in uri else "(none)"
print(f"scheme:           {scheme}  (expected mongodb or mongodb+srv)")

# Split userinfo@host
try:
    after = uri.split("://", 1)[1]
except IndexError:
    print("ERROR: no '://' in the string")
    raise SystemExit(0)

if "@" not in after:
    print("ERROR: no '@' found - missing user:password@host section")
    raise SystemExit(0)

userinfo, hostpart = after.split("@", 1)

if ":" in userinfo:
    user, pwd = userinfo.split(":", 1)
else:
    user, pwd = userinfo, ""

print(f"username:         {user!r}")
print(f"password length:  {len(pwd)} chars (value hidden)")

# Detect common problems WITHOUT showing the password
placeholders = ["<password>", "<db_password>", "<PASSWORD>", "password", "<pwd>"]
if pwd.lower() in [p.lower() for p in placeholders] or pwd.startswith("<"):
    print("  !! PROBLEM: password still looks like a PLACEHOLDER, not your real password")

raw_specials = re.findall(r"[@:/#?%]", pwd)
if raw_specials:
    print(f"  !! PROBLEM: password contains UN-encoded special chars: {set(raw_specials)}")
    print("     These must be percent-encoded (@->%40 :->%3A /->%2F #->%23 ?->%3F %->%25)")
else:
    print("  password has no obviously unencoded special characters")

if "<" in uri or ">" in uri:
    print("  !! PROBLEM: the string still contains '<' or '>' brackets - remove them")

host = hostpart.split("/", 1)[0].split("?", 1)[0]
print(f"host:             {host}")

# DB name
path = ""
if "/" in hostpart:
    path = hostpart.split("/", 1)[1].split("?", 1)[0]
print(f"db in path:       {path or '(none)'}")
print(f"DB_NAME env:      {os.environ.get('DB_NAME', '(not set)')}")
