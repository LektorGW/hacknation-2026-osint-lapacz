// Wykresy w czystym SVG: słupki skumulowane i diagram przepływu.
import { fmtPln, fmtPlnCompact, sum, truncate } from '../format.ts';
import { layoutSankey } from './sankey.ts';
import type { SankeyLinkInput, SankeyNodeInput } from './sankey.ts';
import { bandScale, linearScale, niceMax, stackSeries, ticks } from './scales.ts';

export interface BarSeries {
  key: string;
  label: string;
  values: number[];
}

interface BarChartProps {
  title: string;
  categories: string[];
  series: BarSeries[];
  height?: number;
}

/** Słupki skumulowane w PLN; te same dane są dostępne jako tabela dla czytników ekranu. */
export function BarChart({ title, categories, series, height = 240 }: BarChartProps) {
  const width = 640;
  const margin = { top: 22, right: 12, bottom: 28, left: 64 };
  const totals = categories.map((_, index) => sum(series.map((item) => item.values[index] ?? 0)));
  const max = niceMax(Math.max(0, ...totals));
  const y = linearScale([0, max], [height - margin.bottom, margin.top]);
  const band = bandScale(categories.length, [margin.left, width - margin.right], 0.45);
  const stacks = stackSeries(series.map((item) => item.values));

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        {ticks(max).map((tick) => (
          <g key={tick}>
            <line className="chart-grid" x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
            <text className="chart-tick" x={margin.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="central">
              {fmtPlnCompact(tick)}
            </text>
          </g>
        ))}
        {categories.map((category, index) => (
          <g key={category}>
            {stacks.map((segments, seriesIndex) => {
              const [from, to] = segments[index]!;
              if (to === from) return null;
              return (
                <rect key={series[seriesIndex]!.key} className={`series-${seriesIndex % 5}`} x={band.start(index)} width={band.width} y={y(to)} height={y(from) - y(to)} rx={2}>
                  <title>{`${category} · ${series[seriesIndex]!.label}: ${fmtPln(to - from)}`}</title>
                </rect>
              );
            })}
            <text className="chart-value" x={band.start(index) + band.width / 2} y={y(totals[index]!) - 7} textAnchor="middle">
              {fmtPlnCompact(totals[index]!)}
            </text>
            <text className="chart-tick" x={band.start(index) + band.width / 2} y={height - 8} textAnchor="middle">
              {category}
            </text>
          </g>
        ))}
      </svg>
      {series.length > 1 && (
        <ul className="legend-row">
          {series.map((item, index) => (
            <li key={item.key}>
              <span className={`swatch series-${index % 5}`} /> {item.label}
            </li>
          ))}
        </ul>
      )}
      <table className="visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Rok</th>
            {series.map((item) => (
              <th key={item.key} scope="col">
                {item.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((category, index) => (
            <tr key={category}>
              <th scope="row">{category}</th>
              {series.map((item) => (
                <td key={item.key}>{fmtPln(item.values[index] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

interface SankeyChartProps {
  title: string;
  nodes: SankeyNodeInput[];
  links: SankeyLinkInput[];
  columns: string[];
}

/** Diagram przepływu: szerokość wstęgi odpowiada wartości w PLN. */
export function SankeyChart({ title, nodes, links, columns }: SankeyChartProps) {
  const width = 760;
  const inner = { width: 520, height: Math.max(220, nodes.length * 26) };
  const offset = { x: 120, y: 30 };
  const layout = layoutSankey(nodes, links, { ...inner, nodeWidth: 12, gap: 14 });
  const lastColumn = Math.max(0, ...layout.nodes.map((node) => node.column));

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${width} ${inner.height + offset.y + 16}`} role="img" aria-label={title}>
        <g transform={`translate(${offset.x},${offset.y})`}>
          {columns.map((label, index) => (
            <text key={label} className="chart-tick chart-column" x={(index * (inner.width - 12)) / Math.max(1, columns.length - 1) + 6} y={-14} textAnchor="middle">
              {label}
            </text>
          ))}
          {layout.links.map((link) => {
            const bend = (link.x1 - link.x0) / 2;
            return (
              <path
                key={`${link.source}>${link.target}`}
                className="sankey-link"
                d={`M${link.x0},${link.sourceY}C${link.x0 + bend},${link.sourceY} ${link.x1 - bend},${link.targetY} ${link.x1},${link.targetY}`}
                strokeWidth={Math.max(1, link.width)}
              >
                <title>{fmtPln(link.value)}</title>
              </path>
            );
          })}
          {layout.nodes.map((node) => {
            const left = node.column === 0;
            const right = node.column === lastColumn;
            return (
              <g key={node.id}>
                <rect className={`sankey-node column-${node.column}`} x={node.x} y={node.y} width={12} height={Math.max(2, node.height)} rx={2}>
                  <title>{`${node.label}: ${fmtPln(node.value)}`}</title>
                </rect>
                <text
                  className="chart-label"
                  x={left ? node.x - 8 : right ? node.x + 20 : node.x + 6}
                  y={left || right ? node.y + node.height / 2 : node.y - 5}
                  textAnchor={left ? 'end' : right ? 'start' : 'middle'}
                  dominantBaseline={left || right ? 'central' : 'auto'}
                >
                  {truncate(node.label, left || right ? 18 : 26)}
                  {(left || right) && <tspan className="chart-sub"> {fmtPlnCompact(node.value)}</tspan>}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </figure>
  );
}
