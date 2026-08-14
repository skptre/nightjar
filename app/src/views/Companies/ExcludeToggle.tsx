interface ExcludeToggleProps {
  excluded: boolean;
  onToggle: () => void;
}

export function ExcludeToggle({ excluded, onToggle }: ExcludeToggleProps): React.ReactNode {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 ${
        excluded
          ? 'bg-nj-ineligible dark:bg-nj-ineligible focus:ring-nj-ineligible/50'
          : 'bg-gray-300 dark:bg-nj-border-bright focus:ring-nj-accent/50'
      }`}
      role="switch"
      aria-checked={excluded}
      aria-label={excluded ? 'Company excluded — click to include' : 'Company included — click to exclude'}
      title={excluded ? 'Excluded — click to include' : 'Click to exclude'}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
          excluded ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}
