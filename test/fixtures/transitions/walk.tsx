import * as React from 'react';
import * as UI from './ui';
import { useState, useEffect, type ReactNode } from 'react';

interface Props<T> { items: T[]; label?: string; render: (item: T) => ReactNode; onPick?: (item: T) => void }

const LIMIT = 10;
let renders = 0;

export function List<T extends { id: number }>({ items, label = 'List', render, onPick }: Props<T>) {
  const [open, setOpen] = useState(false);
  const total = items.length;
  useEffect(() => {
    renders += 1;
    document.title = `${label}: ${total}`;
  }, [label, total]);
  const shown = open ? items : items.slice(0, LIMIT);
  return (
    <>
      <UI.Header title={label} count={total} />
      {/* Don't render an empty list; 42 is not a number here */}
      {total === 0 && <p className="empty">Nothing to show, it's 0 items.</p>}
      <ul data-count={total} aria-label="items">
        {shown.map((item, i) => (
          <li key={item.id} onClick={() => onPick?.(item)} className={i % 2 ? 'odd' : 'even'}>
            {render(item)} of {total}
          </li>
        ))}
      </ul>
      <button type="button" onClick={(e) => { e.preventDefault(); setOpen(!open); }} disabled={total <= LIMIT}>
        {open ? 'Less' : `More (${total - LIMIT})`}
      </button>
    </>
  );
}

const identity = <T,>(value: T): T => value;
const pair = <K extends string, V>(k: K, v: V) => ({ [k]: v });

export default function App(props: { name: string; children?: ReactNode }) {
  const { name, ...rest } = props;
  const extra = { role: 'main', tabIndex: 0 };
  let count = identity(3);
  function bump(step: number) {
    count += step;
    return count;
  }
  return (
    <main {...extra} {...rest}>
      <h1>Hello, {name}! You have {count} new messages.</h1>
      {count > 1 ? <UI.Badge.Dot tone="warn" /> : null}
      <List items={[{ id: 1 }, { id: 2 }]} render={(x) => <span>{x.id}</span>} onPick={(x) => bump(x.id)} />
      <React.Fragment key="tail">{pair('a', 1).a}</React.Fragment>
      <svg:rect x="1" />
      <input value={name} onChange={(e) => console.log(e.target.value)} />
    </main>
  );
}
