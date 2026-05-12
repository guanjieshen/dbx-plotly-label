from fastapi import APIRouter, HTTPException, Query

from backend.db import UC_VOLUME_PATH, volume_list

router = APIRouter()


@router.get("/tree")
def tree(path: str = Query(default="")):
    """Return immediate children of a UC volume path.

    `path` may be:
      - empty / "/"  -> list root of UC_VOLUME_PATH
      - "anomaly"    -> list UC_VOLUME_PATH/anomaly
      - absolute "/Volumes/.../graphs/anomaly" -> use directly
    """
    if not path or path in ("/", "."):
        target = UC_VOLUME_PATH
    elif path.startswith("/Volumes/"):
        target = path
    else:
        target = f"{UC_VOLUME_PATH.rstrip('/')}/{path.lstrip('/')}"
    try:
        entries = volume_list(target)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"volume list failed: {e}")
    return {"path": target, "entries": entries}
