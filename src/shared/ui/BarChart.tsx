import { useMemo } from 'react'

export interface Series {
  key: string
  label: string
  color: string
}

interface BarChartProps {
  data: Record<string, number | string>[]
  series: Series[]
  categoryKey: string
  height?: number
}

/** Простой сгруппированный столбчатый график на SVG. */
export function BarChart({ data, series, categoryKey, height = 240 }: BarChartProps) {
  const max = useMemo(() => {
    let m = 0
    for (const row of data) for (const s of series) m = Math.max(m, Number(row[s.key]) || 0)
    return m || 1
  }, [data, series])

  const groups = data.length
  const groupW = 100 / groups
  const barGap = 0.18
  const innerW = groupW * (1 - barGap * 2)
  const barW = innerW / series.length

  return (
    <div className="w-full">
      <div className="relative" style={{ height }}>
        {/* сетка */}
        <div className="absolute inset-0 flex flex-col justify-between">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="border-t border-line/60" />
          ))}
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {data.map((row, gi) => {
            const gx = gi * groupW + groupW * barGap
            return series.map((s, si) => {
              const v = Number(row[s.key]) || 0
              const h = (v / max) * 96
              return (
                <rect
                  key={s.key + gi}
                  x={gx + si * barW}
                  y={100 - h}
                  width={barW * 0.82}
                  height={h}
                  rx={0.8}
                  fill={s.color}
                  opacity={0.92}
                >
                  <title>{`${row[categoryKey]} · ${s.label}: ${v}`}</title>
                </rect>
              )
            })
          })}
        </svg>
      </div>
      {/* подписи X */}
      <div className="mt-2 flex">
        {data.map((row, i) => (
          <div key={i} className="flex-1 text-center text-xs font-medium text-muted">{String(row[categoryKey])}</div>
        ))}
      </div>
      {/* легенда */}
      <div className="mt-3 flex flex-wrap justify-center gap-4">
        {series.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5 text-xs font-medium text-muted">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </div>
        ))}
      </div>
    </div>
  )
}
