<?php
class Cart {
    public function total(array $items, int $limit): string {
        # 42 is a comment number
        // 7 more
        /* 9 in a block */
        $sum = 0;
        $note = <<<"TXT"
            Sum of items $sum, limit {$limit}, 12 in text
            TXT;
        $raw = <<<'RAW'
            $sum 13 is literal here
            RAW;
        $q = 'multi
        line 14 $sum';
        $cmd = `ls $sum 15`;
        foreach ($items as $i => $item) {
            $sum += $item * 2;
            if ($sum > $limit) { break; }
        }
        #[Pure]
        $out = "{$sum} of {$this->max} {$items[0]}";
        return $note . $raw . $q . $cmd . $out . $sum;
    }
}
?>
<ul><?php foreach ([1, 2] as $n): ?><li><?= $n ?> 16</li><?php endforeach; ?></ul>
