class Tape:
    def cancel_trade(self, time: Time, id: ID):
        """..."""
        if id not in self.cancelled_trades and self.queue:
            min_id, max_id = self.queue[0][0], self.queue[-1][0]
            if min_id <= id <= max_id: # comment
                self.cancelled_trades.add(id)
                queue_position = id - min_id
                id, time, ticker, price, qty = self.queue[queue_position]
                self.vwaps[ticker].subtract(price, qty)
