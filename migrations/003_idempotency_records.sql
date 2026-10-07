CREATE TABLE idempotency_records (
  show_id UUID NOT NULL REFERENCES shows(id),
  user_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 599),
  reservation_id UUID,
  decline_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (show_id, user_id, idempotency_key),
  FOREIGN KEY (reservation_id, show_id) REFERENCES reservations(id, show_id),
  CHECK ((reservation_id IS NOT NULL AND decline_code IS NULL) OR
         (reservation_id IS NULL AND decline_code IS NOT NULL))
);