CREATE TABLE audiences (
    id         bigserial PRIMARY KEY,
    name       varchar(255) NOT NULL UNIQUE,
    definition jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE webhook_subscriptions ADD COLUMN audience varchar(255);
