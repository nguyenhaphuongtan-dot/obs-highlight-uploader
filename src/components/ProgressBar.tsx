type Props = { percent: number; color?: string };

export default function ProgressBar({ percent, color = "var(--accent)" }: Props) {
  const width = Math.min(100, Math.max(0, percent));
  return (
    <div className="progress">
      <div className="progress-bar" style={{ width: `${width}%`, background: color }} />
    </div>
  );
}