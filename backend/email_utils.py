"""Email sending via Resend (transactional)."""
import os
import asyncio
import logging

import resend

logger = logging.getLogger('tbc.email')

RESEND_API_KEY = os.environ.get('RESEND_API_KEY', '')
SENDER_EMAIL = os.environ.get('SENDER_EMAIL', 'onboarding@resend.dev')

if RESEND_API_KEY:
    resend.api_key = RESEND_API_KEY


async def send_email(to: str, subject: str, html: str) -> dict:
    """Send a transactional email. Raises on failure."""
    if not RESEND_API_KEY:
        raise RuntimeError('RESEND_API_KEY not configured')
    params = {'from': SENDER_EMAIL, 'to': [to], 'subject': subject, 'html': html}
    result = await asyncio.to_thread(resend.Emails.send, params)
    logger.info('Email sent to %s (id=%s)', to, result.get('id'))
    return result


def render_password_reset_email(name: str, reset_url: str) -> str:
    """Inline-CSS HTML email — works in every mail client."""
    safe_name = (name or 'there').split('@')[0]
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#e7e3d6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0c;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#13131a;border:1px solid #3a2c08;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:32px 36px 16px 36px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#d4a93a;font-weight:700;">TBC AI Tools</div>
          <h1 style="margin:18px 0 6px 0;font-size:22px;color:#f4eed5;font-weight:700;">Reset your password</h1>
          <p style="margin:6px 0 22px 0;font-size:14px;line-height:1.55;color:#a8a092;">
            Hi {safe_name}, we received a request to reset the password on your TBC AI Tools account.
            Click the button below to choose a new one. The link expires in 30 minutes.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr><td style="border-radius:10px;background:linear-gradient(135deg,#d4a93a 0%,#b8902a 100%);">
              <a href="{reset_url}" style="display:inline-block;padding:13px 26px;color:#0a0a0c;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:.3px;">Reset password →</a>
            </td></tr>
          </table>
          <p style="margin:22px 0 4px 0;font-size:12px;color:#7e7768;">Or copy this URL into your browser:</p>
          <p style="margin:0 0 22px 0;font-size:12px;color:#d4a93a;word-break:break-all;"><a href="{reset_url}" style="color:#d4a93a;">{reset_url}</a></p>
          <p style="margin:0;font-size:12px;color:#7e7768;line-height:1.55;">
            If you didn't request this, you can safely ignore this email — your password won't change.
          </p>
        </td></tr>
        <tr><td style="padding:18px 36px;background:#0e0e14;border-top:1px solid #2a2316;font-size:11px;color:#7e7768;">
          TBC AI Tools · tbctools.org · This is a transactional email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""
