import './codicon.css';

interface CodiconProps {
  name: string;
  size?: number;
  className?: string;
  decorative?: boolean;
}

export function Codicon({ name, size = 16, className = '', decorative = true }: CodiconProps) {
  return (
    <span
      className={`codicon codicon-${name} ${className}`}
      style={{ fontSize: size, width: size, height: size }}
      aria-hidden={decorative}
    />
  );
}
