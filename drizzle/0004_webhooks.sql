CREATE TABLE webhook_subscriptions (
    id               bigserial PRIMARY KEY,
    name             varchar(255) NOT NULL UNIQUE,
    url              text NOT NULL,
    secret           varchar(64) NOT NULL,
    collections      jsonb NOT NULL DEFAULT '[]',
    actions          jsonb NOT NULL DEFAULT '[]',
    record_matchers  jsonb NOT NULL DEFAULT '{}',
    include_record   boolean NOT NULL DEFAULT true,
    max_events       int NOT NULL DEFAULT 200,
    max_wait_ms      int NOT NULL DEFAULT 5000,
    cursor           bigint NOT NULL DEFAULT 0,
    status           varchar(20) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'paused', 'failing')),
    failure_count    int NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    last_delivery_at timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
