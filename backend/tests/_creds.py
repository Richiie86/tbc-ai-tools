"""Shared test credentials helper.

Credentials are sourced EXCLUSIVELY from environment variables. There are NO
real secrets in this file — the fallbacks are obvious non-working placeholders
so nothing sensitive ever lands in version control or a public repo.

To run the integration tests that need an authenticated operator/preview
session, set these on the machine running the tests (CI secret, shell export,
or an untracked `.env`):

    TEST_OPERATOR_EMAIL       operator login email
    TEST_OPERATOR_PASSWORD    operator login password
    TEST_PREVIEW_USER_EMAIL   non-operator preview user email
    TEST_USER_PASSWORD        non-operator preview user password

When they are not set, tests call `require_operator_creds()` /
`require_preview_creds()` which `pytest.skip()` the test instead of running
against production with bogus values.
"""
import os

import pytest

# Obvious placeholders — NOT real credentials. Override via env vars above.
_PLACEHOLDER_EMAIL = 'operator@example.test'
_PLACEHOLDER_PASSWORD = 'set-TEST_OPERATOR_PASSWORD-to-run'

OPERATOR_EMAIL: str = os.environ.get('TEST_OPERATOR_EMAIL', _PLACEHOLDER_EMAIL)
OPERATOR_PASSWORD: str = os.environ.get('TEST_OPERATOR_PASSWORD', _PLACEHOLDER_PASSWORD)
PREVIEW_USER_EMAIL: str = os.environ.get('TEST_PREVIEW_USER_EMAIL', 'preview-user@example.test')
PREVIEW_USER_PASSWORD: str = os.environ.get('TEST_USER_PASSWORD', 'set-TEST_USER_PASSWORD-to-run')

# Back-compat aliases — existing tests use these names verbatim.
OP_EMAIL = OPERATOR_EMAIL
OP_PASSWORD = OPERATOR_PASSWORD


def operator_creds_configured() -> bool:
    """True only when real operator creds were supplied via env vars."""
    return (
        OPERATOR_EMAIL != _PLACEHOLDER_EMAIL
        and OPERATOR_PASSWORD != _PLACEHOLDER_PASSWORD
    )


def require_operator_creds() -> None:
    """Skip the calling test unless real operator creds are configured."""
    if not operator_creds_configured():
        pytest.skip(
            'operator credentials not configured — set TEST_OPERATOR_EMAIL '
            'and TEST_OPERATOR_PASSWORD env vars to run this test'
        )


def preview_creds_configured() -> bool:
    """True only when real preview-user creds were supplied via env vars."""
    return PREVIEW_USER_PASSWORD != 'set-TEST_USER_PASSWORD-to-run'


def require_preview_creds() -> None:
    """Skip the calling test unless real preview-user creds are configured."""
    if not preview_creds_configured():
        pytest.skip(
            'preview-user credentials not configured — set TEST_USER_PASSWORD '
            'env var to run this test'
        )
