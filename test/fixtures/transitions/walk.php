<?php
declare(strict_types=1);
$title = "Self test";
$items = [1, 2, 3];
function total(array $xs): int {
    $sum = 0;
    foreach ($xs as $x) {
        $sum += $x * 42;
    }
    return $sum;
}
class Card {
    private int $async = 3;
    public function render(): string {
        return $this->async . " items";
    }
}
?>
<!doctype html>
<html>
<head>
  <title><?= htmlspecialchars($title) ?></title>
  <style>.card { padding: 4px; }</style>
</head>
<body>
  <h1 class="title">Hello, <?php echo $title; ?> and 42 more</h1>
  <ul>
  <?php foreach ($items as $i => $item): ?>
    <li data-id="<?= $i ?>" onclick="pick(<?= $i ?>)"><?= $item ?></li>
  <?php endforeach; ?>
  </ul>
  <?php if (count($items) > 2) { ?>
    <p>Many self items, this is 3.</p>
  <?php } else { ?>
    <p>Few</p>
  <?php } ?>
  <script>
    const items = <?= json_encode($items) ?>;
    function sum(list) {
      let total = 0;
      for (const n of list) { total += n; }
      return total;
    }
    const self = this;
  </script>
  <p>Total: <?= total($items) ?></p>
</body>
</html>
