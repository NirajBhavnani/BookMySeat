CREATE TABLE shows (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  price_paise BIGINT NOT NULL CHECK (price_paise >= 0),
  per_user_limit INTEGER NOT NULL DEFAULT 4 CHECK (per_user_limit > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seats (
  show_id UUID NOT NULL REFERENCES shows(id),
  seat_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'confirmed')),
  reservation_id UUID,
  PRIMARY KEY (show_id, seat_no),
  CHECK (
    (status = 'available' AND reservation_id IS NULL) OR
    (status = 'confirmed' AND reservation_id IS NOT NULL)
  )
);