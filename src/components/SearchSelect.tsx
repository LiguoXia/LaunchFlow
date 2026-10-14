import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
import { dictionaryOptions, filterOptions, type SearchOption } from '../lib/search-options';

export default function SearchSelect({
  value,
  options,
  onChange,
  label,
  placeholder = '输入名称搜索…',
  emptyText = '没有匹配项',
  disabled = false,
  clearable = false,
  required = false,
}: {
  value: string;
  options: readonly SearchOption[];
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  clearable?: boolean;
  required?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const restoringFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const sorted = useMemo(() => dictionaryOptions(options), [options]);
  const choices = useMemo(() => filterOptions(sorted, query), [sorted, query]);
  const selected = options.find((option) => option.value === value);
  const current = choices.length ? Math.min(active, choices.length - 1) : -1;
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const show = () => {
    if (disabled) return;
    setQuery('');
    setActive(
      Math.max(
        0,
        sorted.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  };
  const choose = (option: SearchOption) => {
    onChange(option.value);
    close();
    restoringFocus.current = true;
    input.current?.focus({ preventScroll: true });
    restoringFocus.current = false;
  };
  useEffect(() => {
    input.current?.setCustomValidity(required && !selected ? '请选择列表中的一项' : '');
  }, [required, selected]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    // Typing again after a choice starts a fresh search instead of appending
    // characters to the committed label displayed in the focused input.
    if (!open && document.activeElement === input.current) input.current?.select();
  }, [open, value]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!input.current) return;
      const rect = input.current.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        setOpen(false);
        return;
      }
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const down = below >= Math.min(240, choices.length * 48 + 16) || below >= above;
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
        maxHeight: Math.max(48, Math.min(320, down ? below : above)),
        ...(down ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
      });
    };
    place();
    window.addEventListener('resize', place);
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) place();
    };
    window.addEventListener('scroll', scroll, true);
    const observer = new ResizeObserver(place);
    if (root.current) observer.observe(root.current);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open, choices.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  useEffect(() => {
    if (open && current >= 0)
      popup.current
        ?.querySelector(`[data-option-index="${current}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [open, current, query]);

  return (
    <div className="search-select" ref={root}>
      <input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-required={required}
        aria-activedescendant={open && current >= 0 ? `${id}-${current}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        value={open ? query : (selected?.label ?? (value ? '已保存的选择（当前列表不可用）' : ''))}
        onFocus={() => {
          if (!restoringFocus.current) show();
        }}
        onClick={() => {
          if (!open) show();
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onBlur={(event) => {
          if (
            !root.current?.contains(event.relatedTarget) &&
            !popup.current?.contains(event.relatedTarget)
          )
            close();
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) show();
            else if (choices.length)
              setActive(
                (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length,
              );
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (!open) show();
            else if (current >= 0) choose(choices[current]);
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === 'Tab') close();
        }}
      />
      <span className="search-select-actions">
        {clearable && value && (
          <button
            type="button"
            aria-label={`清除${label}`}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange('');
              close();
            }}
          >
            <X size={14} />
          </button>
        )}
        <button
          type="button"
          aria-label={`展开${label}`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) close();
            else {
              input.current?.focus({ preventScroll: true });
              show();
            }
          }}
        >
          <ChevronDown size={15} />
        </button>
      </span>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="search-select-popover"
            style={position}
            role="listbox"
            id={`${id}-list`}
            aria-label={`${label}选项`}
          >
            {choices.length ? (
              choices.map((option, index) => (
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  id={`${id}-${index}`}
                  key={option.value}
                  aria-selected={option.value === value}
                  data-option-value={option.value}
                  data-option-index={index}
                  className={`search-select-option${current === index ? ' active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(option)}
                >
                  <span>
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                  {option.value === value && <Check size={15} />}
                </button>
              ))
            ) : (
              <div className="search-select-empty" role="status">
                {emptyText}
              </div>
            )}
          </div>,
          // Modal dialogs make the rest of the document inert. Keep their options
          // in the same top layer while escaping the scrolling field container.
          root.current?.closest('dialog') ?? document.body,
        )}
    </div>
  );
}
