from fastapi import APIRouter, Request

from backend.auth import get_user_email

router = APIRouter()


@router.get("")
def me(request: Request):
    return {"email": get_user_email(request)}
