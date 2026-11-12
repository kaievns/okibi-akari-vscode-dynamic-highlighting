import * as React from 'react';
import * as api from './api.js';
import { useState, useEffect } from 'react';

const LIMIT = 10;
let renders = 0;

/**
 * The first `limit` rows, and a button for the rest.
 * @param {{ items: Array<{ id: number, name: string }>, limit?: number }} props [limit]
 * @returns {JSX.Element}
 */
export function Rows({ items, limit = LIMIT, onPick }) {
  const [open, setOpen] = useState(false);
  const total = items.length;
  useEffect(() => {
    renders += 1;
    document.title = `${total} rows, ${renders} renders`;
  }, [total]);
  const shown = open ? items : items.slice(0, limit);
  return (
    <>
      {/* 42 is not a number in a comment */}
      <h2 className="title">Rows: {total} of {limit}, it's 0 left</h2>
      <ul data-count={total}>
        {shown.map((row, i) => (
          <li key={row.id} onClick={() => onPick?.(row)} className={i % 2 ? 'odd' : 'even'}>
            {`${i + 1}. ${row.name}`}
          </li>
        ))}
      </ul>
      {total > limit && <button onClick={() => setOpen(!open)}>{open ? 'Less' : `More (${total - limit})`}</button>}
    </>
  );
}

export class Counter extends React.Component {
  state = { count: 0 };
  bump = (n) => {
    this.setState({ count: this.state.count + n });
  };
  render() {
    const { label = 'Count', ...rest } = this.props;
    return <button {...rest} onClick={() => this.bump(1)}>{label}: {this.state.count}</button>;
  }
}

export default async function load(id) {
  const res = await api.fetchRows(`/rows/${id}?limit=${LIMIT}`);
  return <Rows items={res.rows} limit={LIMIT * 2} onPick={(row) => console.log(row.id)} />;
}
