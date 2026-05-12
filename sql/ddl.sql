-- Reference DDL for the eval-labelling app.
-- bin/deploy.sh runs these statements via the SQL Statements API,
-- substituting the catalog/schema from .deploy.yaml.
--
-- The literal {{CATALOG}} and {{SCHEMA}} tokens are replaced at deploy time.

CREATE SCHEMA IF NOT EXISTS `{{CATALOG}}`.`{{SCHEMA}}`;

CREATE TABLE IF NOT EXISTS `{{CATALOG}}`.`{{SCHEMA}}`.graphs (
  graph_path       STRING NOT NULL,
  status           STRING NOT NULL,
  assignee_email   STRING,
  completed_by     STRING,
  completed_at     TIMESTAMP,
  created_at       TIMESTAMP NOT NULL,
  metadata         MAP<STRING, STRING>
)
USING DELTA
TBLPROPERTIES (delta.enableChangeDataFeed = true);

CREATE TABLE IF NOT EXISTS `{{CATALOG}}`.`{{SCHEMA}}`.annotations (
  annotation_id   STRING NOT NULL,
  graph_path      STRING NOT NULL,
  shape_type      STRING NOT NULL,
  x               DOUBLE,
  y               DOUBLE,
  width           DOUBLE,
  height          DOUBLE,
  image_width     INT,
  image_height    INT,
  label_class     STRING,
  created_by      STRING,
  created_at      TIMESTAMP NOT NULL,
  updated_at      TIMESTAMP,
  frozen          BOOLEAN,
  deleted         BOOLEAN
)
USING DELTA
TBLPROPERTIES (delta.enableChangeDataFeed = true);

CREATE TABLE IF NOT EXISTS `{{CATALOG}}`.`{{SCHEMA}}`.comments (
  comment_id        STRING NOT NULL,
  annotation_id     STRING,
  parent_comment_id STRING,
  author_email      STRING,
  body              STRING,
  created_at        TIMESTAMP NOT NULL,
  scope             STRING,
  graph_path        STRING
)
USING DELTA
TBLPROPERTIES (delta.enableChangeDataFeed = true);

-- Idempotent migrations for tables that may already exist from earlier deploys.
-- NOTE: Databricks SQL does NOT support `ADD COLUMN IF NOT EXISTS`. The deploy
-- script treats FIELD_ALREADY_EXISTS as success, so re-running these is safe.
ALTER TABLE `{{CATALOG}}`.`{{SCHEMA}}`.comments ALTER COLUMN annotation_id DROP NOT NULL;
ALTER TABLE `{{CATALOG}}`.`{{SCHEMA}}`.comments ADD COLUMN scope STRING;
ALTER TABLE `{{CATALOG}}`.`{{SCHEMA}}`.comments ADD COLUMN graph_path STRING;

ALTER TABLE `{{CATALOG}}`.`{{SCHEMA}}`.annotations ADD COLUMN applies_to STRING;
ALTER TABLE `{{CATALOG}}`.`{{SCHEMA}}`.annotations ADD COLUMN data_x_min DOUBLE;
ALTER TABLE `{{CATALOG}}`.`{{SCHEMA}}`.annotations ADD COLUMN data_x_max DOUBLE;
ALTER TABLE `{{CATALOG}}`.`{{SCHEMA}}`.annotations ADD COLUMN data_y_min DOUBLE;
ALTER TABLE `{{CATALOG}}`.`{{SCHEMA}}`.annotations ADD COLUMN data_y_max DOUBLE;
ALTER TABLE `{{CATALOG}}`.`{{SCHEMA}}`.annotations ADD COLUMN custom_label STRING;

-- Snapshot of underlying data points inside each annotation's data bbox at
-- the moment of save. Detached from chart_points so source-table churn can't
-- silently change a labelled region's payload.
CREATE TABLE IF NOT EXISTS `{{CATALOG}}`.`{{SCHEMA}}`.annotation_data_points (
  annotation_id  STRING NOT NULL,
  chart_id       STRING NOT NULL,
  trace_id       STRING NOT NULL,
  point_id       STRING NOT NULL,
  x              DOUBLE,
  y              DOUBLE,
  extras         MAP<STRING, STRING>,
  captured_at    TIMESTAMP NOT NULL
)
USING DELTA
TBLPROPERTIES (delta.enableChangeDataFeed = true);

-- Canonical "data behind every chart" table. Upstream pipelines write here;
-- the labelling app reads. One row per (chart_id, trace_id, point_id).
CREATE TABLE IF NOT EXISTS `{{CATALOG}}`.`{{SCHEMA}}`.chart_points (
  chart_id    STRING NOT NULL,
  trace_id    STRING NOT NULL,
  point_id    STRING NOT NULL,
  x           DOUBLE,
  y           DOUBLE,
  extras      MAP<STRING, STRING>,
  ingested_at TIMESTAMP NOT NULL
)
USING DELTA
TBLPROPERTIES (delta.enableChangeDataFeed = true);
