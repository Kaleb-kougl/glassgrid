import { useState, type ReactNode } from 'react';
import { APP_NAME, compileCountQuery, quoteIdent, type ColumnType } from '@glassgrid/core';
import {
  AgentIndicator,
  BarChart,
  Button,
  ChartCard,
  ChartSkeleton,
  ColumnListRow,
  DataGrid,
  FilterChip,
  FocusRing,
  HistoryItem,
  ProgressBar,
  SegmentedControl,
  ShelfChip,
  Spinner,
  Toast,
  Tooltip,
  TypeMenu,
  tokensFor,
  type BarDatum,
  type GridColumn,
  type ThemeName,
} from '@glassgrid/ui';

function Section({ title, wide = false, children, note }: { title: string; wide?: boolean; children: ReactNode; note?: string }) {
  return (
    <section className={wide ? 'sheet__card sheet__card--wide' : 'sheet__card'}>
      <h3 className="sheet__label">{title}</h3>
      {children}
      {note !== undefined && <p className="sheet__note">{note}</p>}
    </section>
  );
}

const bars: BarDatum[] = [
  { key: '"Credit card"', label: 'Credit card', value: 2_688_301 },
  { key: '"Cash"', label: 'Cash', value: 631_488 },
  { key: '"Unknown"', label: 'Unknown', value: 152_906 },
  { key: '"No charge"', label: 'No charge', value: 19_877 },
  { key: '"Dispute"', label: 'Dispute', value: 12_640 },
];

const gridColumns: GridColumn[] = [
  { name: 'pickup_datetime', type: 'timestamp', width: 168 },
  { name: 'passenger_count', type: 'integer', width: 116 },
  { name: 'trip_distance', type: 'float', width: 104 },
  { name: 'payment_type', type: 'text', width: 112 },
];
const gridRows = Array.from({ length: 6 }, (_, i) => [
  `2023-01-01 00:0${i}:${String(20 + i * 7).padStart(2, '0')}`,
  i === 4 ? null : String((i % 3) + 1),
  (2.24 + i * 0.61).toFixed(2),
  i % 3 === 2 ? 'Cash' : 'Credit card',
]);

function ColumnRows() {
  const [types, setTypes] = useState<Record<string, ColumnType>>({ trip_distance: 'float', payment_type: 'text' });
  return (
    <ul className="gg-column-list" style={{ padding: 0 }}>
      <ColumnListRow name="trip_distance" type={types['trip_distance'] ?? 'float'} inferredType="float" distinct="4,218" onTypeChange={(t) => setTypes({ ...types, trip_distance: t })} />
      <ColumnListRow name="passenger_count" type="integer" inferredType="integer" distinct="10" selected onTypeChange={() => undefined} />
      <ColumnListRow name="payment_type" type={types['payment_type'] ?? 'text'} inferredType="integer" distinct="5" onTypeChange={(t) => setTypes({ ...types, payment_type: t })} />
      <ColumnListRow name="PULocationID" type="integer" inferredType="integer" distinct="" profiling onTypeChange={() => undefined} />
    </ul>
  );
}

function Sheet({ theme }: { theme: ThemeName }) {
  const [segment, setSegment] = useState<'bar' | 'line' | 'area' | 'histogram' | 'heatmap' | 'scatter'>('bar');
  const [view, setView] = useState<'chart' | 'data'>('chart');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(['"Cash"']));
  const [toastOpen, setToastOpen] = useState(true);
  const tokens = tokensFor(theme);
  return (
    <div className="sheet" data-gg-theme={theme} data-testid={`sheet-${theme}`}>
      <header className="sheet__head">
        <h2 className="sheet__title">Components</h2>
        <span className="sheet__sub">{theme === 'dark' ? 'Dark' : 'Light'} theme · all values from tokens/glassgrid.css</span>
      </header>

      <Section title="Buttons" note="28px in toolbars, 26px in cards and panels, 32px for the one primary action on a screen. Icon buttons carry a tooltip with the shortcut.">
        <div className="sheet__row">
          <Button variant="primary">Open…</Button>
          <Button variant="primary" disabled>
            Open…
          </Button>
          <Button variant="secondary">Open file</Button>
          <Button variant="secondary" disabled>
            Open file
          </Button>
        </div>
        <div className="sheet__row">
          <Button variant="ghost">
            History<span className="gg-button__detail">14</span>
          </Button>
          <Button variant="ghost" disabled>
            History
          </Button>
          <Button variant="icon" label="Undo" shortcut="⌘Z">
            ↶
          </Button>
          <Button variant="icon" label="Redo" shortcut="⇧⌘Z" disabled>
            ↷
          </Button>
          <Button variant="primary" size="lg">
            Open CSV…
          </Button>
        </div>
      </Section>

      <Section title="Column list row" note="Selected = in the grid selection. A type the person set gets an accent badge; the badge opens the type menu.">
        <ColumnRows />
      </Section>

      <Section title="Type dropdown" note="Click the badge (or press ↓ on it).">
        <div className="sheet__row">
          <TypeMenu column="payment_type" type="integer" inferredType="integer" onChange={() => undefined} />
          <TypeMenu column="payment_type" type="text" inferredType="integer" onChange={() => undefined} />
        </div>
      </Section>

      <Section title="Shelf chip" note="The aggregate lives in the Y chip (sum(fare_amount)); there is no separate aggregate shelf.">
        <div className="sheet__grid2">
          <span>Filled</span>
          <ShelfChip shelf="X" value="month(pickup_datetime)" />
          <span>Aggregate</span>
          <ShelfChip
            shelf="Y"
            value="sum(fare_amount)"
            onRemove={() => undefined}
            menu={['count', 'sum', 'avg', 'min', 'max'].map((a) => ({ kind: 'radio' as const, id: a, label: `${a}(fare_amount)`, checked: a === 'sum', onSelect: () => undefined }))}
          />
          <span>By AI</span>
          <ShelfChip shelf="Color" value="payment_type" addedBy="ai" />
          <span>Empty</span>
          <ShelfChip shelf="Color" onDropColumn={() => undefined} pendingColumn="payment_type" />
        </div>
      </Section>

      <Section title="Filter chip" note="Always names the column and the condition in words. Backspace on a focused chip removes it.">
        <div className="sheet__col">
          <FilterChip column="payment_type" condition="= Cash" onRemove={() => undefined} />
          <FilterChip column="trip_distance" condition="2.00 – 6.00" onRemove={() => undefined} />
          <FilterChip column="pickup_datetime" condition="Jan 9 – Jan 15" onRemove={() => undefined} />
        </div>
      </Section>

      <Section title="Segmented control" note="Arrow keys move; the selected segment is raised and semibold.">
        <div className="sheet__col">
          <SegmentedControl label="View" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'data', label: 'Data' }]} />
          <SegmentedControl
            label="Chart type"
            value={segment}
            onChange={setSegment}
            options={[
              { value: 'bar', label: 'Bar' },
              { value: 'line', label: 'Line' },
              { value: 'area', label: 'Area' },
              { value: 'histogram', label: 'Histogram' },
              { value: 'heatmap', label: 'Heatmap' },
              { value: 'scatter', label: 'Scatter', disabled: true },
            ]}
          />
        </div>
      </Section>

      <Section title="Chart card" wide note="Default · with selection (count + Clear, never colour alone) · created by the agent · loading (skeleton after 300 ms) · engine error.">
        <div className="sheet__cards">
          <ChartCard
            title="Trips by payment type"
            onRename={() => undefined}
            selection={selected.size > 0 ? { summary: `${selected.size} selected`, onClear: () => setSelected(new Set()) } : undefined}
            menu={[{ id: 'remove', label: 'Remove chart', tone: 'danger', onSelect: () => undefined }]}
            shelves={
              <div className="gg-shelves">
                <ShelfChip shelf="X" value="payment_type" />
                <ShelfChip shelf="Y" value="count(*)" menu={[{ kind: 'radio', id: 'c', label: 'count(*)', checked: true, onSelect: () => undefined }]} />
                <ShelfChip shelf="Color" />
              </div>
            }
            viewData={{ on: false, onToggle: () => undefined, table: null }}
            rowsLabel="5 rows"
          >
            <BarChart
              data={bars}
              selected={selected}
              tokens={tokens}
              valueLabel="count(*)"
              label="Trips by payment type"
              onToggle={(d) => {
                const next = new Set(selected);
                if (next.has(d.key)) next.delete(d.key);
                else next.add(d.key);
                setSelected(next);
              }}
            />
          </ChartCard>
          <div className="sheet__col">
            <ChartCard title="Trips by hour and weekday" attribution="ai" menu={[]} rowsLabel="168 rows" />
            <ChartCard title="Fare by pickup hour" status="loading" loadingDelayMs={0} rowsLabel="–" />
            <ChartCard
              title="Trip distance"
              status="error"
              error={{ message: 'y.aggregate "sum" needs a numeric column, but "payment_type" is text. Use "count" instead.', detail: 'y.aggregate' }}
              rowsLabel="–"
            />
          </div>
        </div>
      </Section>

      <Section title="Tooltip" note="Values come from the aggregate rows, never from pixel position; flips at container edges.">
        <div className="sheet__tooltips">
          <Tooltip anchor={{ x: -10, y: -10 }} title="Fri, Jan 20, 2023" rows={[{ label: 'count(*)', value: '22,481' }]} />
          <Tooltip
            anchor={{ x: 330, y: 60 }}
            title="trip_distance 3.00 – 4.00"
            rows={[
              { label: 'count(*)', value: '160,402' },
              { label: 'share', value: '8.715%' },
            ]}
          />
        </div>
      </Section>

      <Section title="Toast" note="Bottom-centre of the grid, one at a time. Info toasts stay 6 s; error toasts stay until dismissed.">
        <div className="sheet__col">
          {toastOpen ? (
            <Toast message="Removed filter payment_type" action={{ label: 'Undo', shortcut: '⌘Z', onClick: () => undefined }} onDismiss={() => setToastOpen(false)} timeoutMs={600_000} />
          ) : (
            <Button size="sm" onClick={() => setToastOpen(true)}>
              Show toast
            </Button>
          )}
          <Toast tone="error" message="Couldn't open trips.csv: file is locked" action={{ label: 'Retry', onClick: () => undefined }} onDismiss={() => undefined} />
        </div>
      </Section>

      <Section title="History list item" note="Filled dot = current state. Items after it are undone (struck through) and can be redone.">
        <ol className="gg-history sheet__history">
          <HistoryItem label="Filter trip_distance < 2.00" caller="user" time="14:33" state="undone" onSelect={() => undefined} />
          <HistoryItem label="Added chart “Trips by hour and weekday”" caller="ai" time="14:32" state="current" onSelect={() => undefined} />
          <HistoryItem label="Brushed trip_distance 2.00 – 6.00" caller="user" time="14:29" state="applied" onSelect={() => undefined} />
          <HistoryItem label="Selected payment_type = Cash" caller="user" time="14:28" state="applied" onSelect={() => undefined} />
        </ol>
      </Section>

      <Section title="Progress" note="Reduced motion: no sweep or spin; the percentage and the “Updating…” text carry the state.">
        <div className="sheet__col">
          <ProgressBar label="Optimizing file" value={0.38} />
          <ProgressBar variant="titlebar" label="Optimizing file" value={0.38} />
          <div className="sheet__row">
            <span className="sheet__muted">Profiling PULocationID</span>
            <ProgressBar variant="mini" label="Profiling PULocationID" value={0.6} />
          </div>
          <Spinner label="Updating…" />
          <ChartSkeleton rows={[['60%', '74%'], ['40%', '22%']]} />
        </div>
      </Section>

      <Section title="Agent indicator" note="v1 shows the inactive placeholder; the active variant is for v2 (MCP).">
        <div className="sheet__col">
          <AgentIndicator status="off" />
          <AgentIndicator status="editing" />
        </div>
      </Section>

      <Section title="Keyboard focus" wide note="2px ring in the focus colour, 2px offset outside controls; inset on grid cells. Shown for keyboard focus only (:focus-visible) — press Tab.">
        <div className="sheet__row">
          <Button>Button</Button>
          <ShelfChip shelf="X" value="payment_type" />
          <FocusRing>
            <div tabIndex={0} className="sheet__focus-card">
              Chart card
            </div>
          </FocusRing>
        </div>
        <div className="sheet__grid">
          <DataGrid columns={gridColumns} rowCount={gridRows.length} getRow={(i) => gridRows[i]} sort={[{ column: 'pickup_datetime', direction: 'asc' }]} label="Sample rows" />
        </div>
      </Section>
    </div>
  );
}

export function Gallery() {
  return (
    <main className="gallery">
      <header className="gallery__head">
        <h1>{APP_NAME} component gallery</h1>
        <p>
          The Claude Design component sheet rendered from <code>@glassgrid/ui</code>, dark and light side by side. The shared row-count
          query compiles here too: <code>{compileCountQuery(quoteIdent('trips'), [], []).sql}</code>
        </p>
      </header>
      <div className="gallery__sheets">
        <Sheet theme="dark" />
        <Sheet theme="light" />
      </div>
    </main>
  );
}
