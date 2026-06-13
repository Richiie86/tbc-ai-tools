"""Shared test credentials helper.

Centralises the operator email + password literal that every `test_p6_*.py`
module needs so the secret scanner only flags ONE place. Values are
sourced from env vars first (so CI can override without code changes),
with the documented preview defaults as fall-backs.

Defaults match `/app/memory/test_credentials.md` — the operator can rotate
these by setting the same env vars on the deployment.
"""
import os

OPERATOR_EMAIL: str = os.environ.get('TEST_OPERATOR_EMAIL', 'rac.investments.swe@gmail.com')
OPERATOR_PASSWORD: str = os.environ.get('TEST_OPERATOR_PASSWORD', '123Admin@98')
PREVIEW_USER_EMAIL: str = os.environ.get('TEST_PREVIEW_USER_EMAIL', 'preview-user@tbctools.dev')
PREVIEW_USER_PASSWORD: str = os.environ.get('TEST_USER_PASSWORD', 'TestUser-123')

# Back-compat aliases — the existing tests use these names verbatim.
OP_EMAIL = OPERATOR_EMAIL
OP_PASSWORD = OPERATOR_PASSWORD
