import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { effectiveColumnType, type ColumnState, type FilterInput } from '@glassgrid/core';
import { Button, Popover } from '@glassgrid/ui';
import { buildFilter, OPERATOR_LABELS, operatorsFor, valueFields, valuePlaceholder, type FilterOperator } from './filter-editor-model';

export interface FilterEditorProps {
  columns: readonly ColumnState[];
  /** Column to start with (e.g. the one selected in the grid). */
  initialColumn?: string;
  /** Dispatches `addFilter`; rejects with the command's message, shown in the form. */
  onSubmit: (filter: FilterInput) => Promise<void>;
  disabled?: boolean;
}

type Field = 'min' | 'max' | 'value';

/**
 * "+ Filter": column → operator → value(s), validated as typed, then
 * `addFilter`. A filter added here applies to every view, the grid included,
 * and shows as a chip like a brush does.
 */
export function FilterEditor({ columns, initialColumn, onSubmit, disabled }: FilterEditorProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const [open, setOpen] = useState(false);
  const [columnName, setColumnName] = useState('');
  const [operator, setOperator] = useState<FilterOperator>('oneOf');
  const [values, setValues] = useState<Record<Field, string>>({ min: '', max: '', value: '' });
  const [error, setError] = useState<{ field: Field | 'form'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const column = columns.find((candidate) => candidate.name === columnName) ?? columns[0];
  const type = column ? effectiveColumnType(column) : 'text';
  const operators = operatorsFor(type);
  const shown = operators.includes(operator) ? operator : (operators[0] ?? 'isNull');
  const fields = valueFields(shown);

  const reset = (name: string) => {
    const next = columns.find((candidate) => candidate.name === name) ?? columns[0];
    setColumnName(next?.name ?? '');
    setOperator(operatorsFor(next ? effectiveColumnType(next) : 'text')[0] ?? 'isNull');
    setValues({ min: '', max: '', value: '' });
    setError(null);
  };

  useEffect(() => {
    if (open) firstFieldRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => anchorRef.current?.focus());
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!column) return;
    const built = buildFilter(column.name, type, shown, values);
    if (!built.ok) {
      setError({ field: built.field, message: built.message });
      return;
    }
    setBusy(true);
    try {
      await onSubmit(built.filter);
      close();
    } catch (cause) {
      setError({ field: 'form', message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const valueInput = (field: Field, label: string, list = false) => {
    const invalid = error?.field === field;
    return (
      <label className="filter-editor__field">
        <span className="filter-editor__label">{label}</span>
        <input
          className="filter-editor__input"
          value={values[field]}
          placeholder={valuePlaceholder(type, list)}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(event) => {
            setValues((before) => ({ ...before, [field]: event.target.value }));
            if (error?.field === field || error?.field === 'form') setError(null);
          }}
          data-testid={`filter-editor-${field}`}
        />
      </label>
    );
  };

  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          reset(initialColumn ?? columnName);
          setOpen(true);
        }}
        data-testid="add-filter"
      >
        + Filter
      </Button>
      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} role="dialog" aria-label="Add a filter" className="filter-editor">
        <form
          onSubmit={(event) => void submit(event)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
          data-testid="filter-editor"
        >
          <label className="filter-editor__field">
            <span className="filter-editor__label">Column</span>
            <select
              ref={firstFieldRef}
              className="filter-editor__input"
              value={column?.name ?? ''}
              onChange={(event) => reset(event.target.value)}
              data-testid="filter-editor-column"
            >
              {columns.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-editor__field">
            <span className="filter-editor__label">Condition</span>
            <select
              className="filter-editor__input"
              value={shown}
              onChange={(event) => {
                setOperator(event.target.value as FilterOperator);
                setError(null);
              }}
              data-testid="filter-editor-operator"
            >
              {operators.map((option) => (
                <option key={option} value={option}>
                  {OPERATOR_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          {fields === 2 && (
            <div className="filter-editor__pair">
              {valueInput('min', 'From')}
              {valueInput('max', 'To')}
            </div>
          )}
          {fields === 1 && valueInput('value', 'Value')}
          {fields === 'list' && valueInput('value', 'Values, separated by commas', true)}
          {error && (
            <p id={`${id}-error`} className="filter-editor__error" role="alert" data-testid="filter-editor-error">
              {error.message}
            </p>
          )}
          <div className="filter-editor__actions">
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={busy} data-testid="filter-editor-submit">
              Add filter
            </Button>
          </div>
        </form>
      </Popover>
    </>
  );
}
