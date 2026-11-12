import * as UI from './ui';
import { useState } from 'react';

const LIMIT = 10;

export function Counter({ start = 0, step = 1, label }) {
  const [count, setCount] = useState(start);
  const self = { count };
  function bump(by) {
    let next = count + by;
    if (next > LIMIT) next = LIMIT;
    setCount(next);
    return next;
  }
  return (
    <div className="counter" data-limit={LIMIT}>
      <UI.Header title={label} count={count} />
      {/* it's a comment, 7 too */}
      <p>Count is {count}, step {step}. Don't go past 10.</p>
      {count > 0 && <button onClick={() => bump(-step)}>-{step}</button>}
      <button onClick={() => bump(step)} title={`add ${step}`}>+</button>
      {[1, 2, 3].map((n) => <span key={n}>{n * count}</span>)}
      <>{self.count}</>
    </div>
  );
}

export default function App(props) {
  const { title, ...rest } = props;
  return <Counter {...rest} label={title} start={2} />;
}
