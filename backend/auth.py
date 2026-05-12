"""User identity extraction from Databricks Apps headers."""
from fastapi import Request


def get_user_email(request: Request) -> str:
    """Read the user email injected by Databricks Apps reverse proxy.

    Falls back to a placeholder when running locally (no header present).
    """
    email = (
        request.headers.get("x-forwarded-email")
        or request.headers.get("X-Forwarded-Email")
        or request.headers.get("x-forwarded-user")
    )
    if not email:
        return "local-dev@example.com"
    return email
