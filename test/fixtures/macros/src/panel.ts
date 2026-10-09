export interface PanelProps {
  title: string
  count?: number
  tags?: string[]
  mode: 'compact' | 'full'
}

export interface PanelEmits {
  (e: 'change', value: number): void
  (e: 'close'): void
}
