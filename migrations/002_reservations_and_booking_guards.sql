CREATE TABLE reservations (
  id UUID PRIMARY KEY,
  show_id UUID NOT NULL REFERENCES shows(id),
  user_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  UNIQUE (id, show_id),
  CHECK (
    (status = 'confirmed' AND cancelled_at IS NULL) OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
  )
);

ALTER TABLE seats
  ADD CONSTRAINT seats_reservation_fk
  FOREIGN KEY (reservation_id, show_id)
  REFERENCES reservations(id, show_id);

CREATE TABLE reservation_seats (
  reservation_id UUID NOT NULL,
  show_id UUID NOT NULL,
  seat_no TEXT NOT NULL,
  PRIMARY KEY (reservation_id, seat_no),
  FOREIGN KEY (reservation_id, show_id)
    REFERENCES reservations(id, show_id),
  FOREIGN KEY (show_id, seat_no)
    REFERENCES seats(show_id, seat_no)
);

CREATE TABLE booking_guards (
  show_id UUID NOT NULL REFERENCES shows(id),
  user_id UUID NOT NULL,
  PRIMARY KEY (show_id, user_id)
);