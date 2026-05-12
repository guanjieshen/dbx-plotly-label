import json
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()

_CFG = Path(__file__).resolve().parent.parent / "config" / "label_classes.json"


@router.get("")
def list_classes():
    with open(_CFG, "r") as f:
        return json.load(f)
