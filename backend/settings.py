"""Centralized environment settings.

All values are read from environment variables which `app.yaml` populates
either statically (`value:`) or via app resources (`valueFrom:`). Don't
import this module from db.py to avoid a circular import — db.py uses the
same env vars directly.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    workspace_host: str
    catalog: str
    schema: str
    volume_path: str
    warehouse_id: str

    @property
    def fq_graphs(self) -> str:
        return f"`{self.catalog}`.`{self.schema}`.`graphs`"

    @property
    def fq_annotations(self) -> str:
        return f"`{self.catalog}`.`{self.schema}`.`annotations`"

    @property
    def fq_comments(self) -> str:
        return f"`{self.catalog}`.`{self.schema}`.`comments`"


def get_settings() -> Settings:
    host = os.environ.get("DATABRICKS_HOST", "")
    if host and not host.startswith("http"):
        host = f"https://{host}"
    return Settings(
        workspace_host=host,
        catalog=os.environ.get("UC_CATALOG", "classic_stable_ccu63h"),
        schema=os.environ.get("UC_SCHEMA", "eval_labelling"),
        volume_path=os.environ.get(
            "UC_VOLUME_PATH",
            "/Volumes/classic_stable_ccu63h/eval_labelling/graphs",
        ),
        warehouse_id=os.environ.get("DATABRICKS_WAREHOUSE_ID", ""),
    )
