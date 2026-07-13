import './RubikLoader.css';

const CELL_COLORS = ['#e64545', '#f5f5f5', '#3d81f6', '#ffd500', '#2ecc71', '#ff8c1a'];

const FALL_ORDER = [2, 0, 3, 1];

const STAGGER_S = 0.28;

export function RubikLoader({ label = 'Working…' }: { label?: string }) {
  return (
    <div className="rubik-loader" role="status" aria-label={label}>
      <div className="rubik-grid">
        {CELL_COLORS.map((color, i) => (
          <span
            key={i}
            className="rubik-cell"
            style={{ background: color, animationDelay: `${FALL_ORDER[i] * STAGGER_S}s` }}
          />
        ))}
      </div>
      <span className="rubik-label">{label}</span>
    </div>
  );
}
