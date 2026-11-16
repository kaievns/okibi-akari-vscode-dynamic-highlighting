-- report: self and this {not a block} 42
/* block comment with ( parens ) and 7 */
CREATE TABLE orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  total numeric(10, 2) DEFAULT 0,
  "self" text,
  note text DEFAULT 'it''s this'
);

WITH recent AS (
  SELECT o.customer_id, sum(o.total) AS spent, count(*) AS n
  FROM orders AS o
  WHERE o.created_at > now() - interval '30 days'
  GROUP BY o.customer_id
), ranked AS (
  SELECT r.*, rank() OVER (ORDER BY r.spent DESC) AS pos
  FROM recent r
)
SELECT c.name, ranked.spent, ranked.pos
FROM ranked
JOIN customers c ON c.id = ranked.customer_id
WHERE ranked.pos <= 10 AND c.name LIKE 'A%';

UPDATE orders SET total = total * 1.1;
UPDATE orders SET total = 0 WHERE id = 42;
DELETE FROM orders;
DELETE FROM orders WHERE total < 0;
TRUNCATE TABLE audit_log;
DROP TABLE IF EXISTS tmp_orders;

CREATE OR REPLACE FUNCTION order_total(cid integer) RETURNS numeric AS $$
DECLARE
  spent numeric := 0;
BEGIN
  SELECT coalesce(sum(total), 0) INTO spent FROM orders WHERE customer_id = cid;
  IF spent > 1000 THEN
    RETURN spent * 0.9;
  END IF;
  RETURN spent;
END;
$$ LANGUAGE plpgsql;
