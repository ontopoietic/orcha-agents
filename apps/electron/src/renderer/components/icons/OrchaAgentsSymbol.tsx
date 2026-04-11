interface OrchaAgentsSymbolProps {
  className?: string
}

/**
 * Orcha Agents "O" symbol - pixel art ring icon
 * Uses accent color from theme (currentColor from className)
 */
export function OrchaAgentsSymbol({ className }: OrchaAgentsSymbolProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 2H16V4H18V6H20V8H22V16H20V18H18V20H16V22H8V20H6V18H4V16H2V8H4V6H6V4H8V2ZM8 6V8H6V16H8V18H16V16H18V8H16V6H8Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  )
}
