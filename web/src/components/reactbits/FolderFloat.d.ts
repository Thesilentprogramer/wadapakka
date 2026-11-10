export type FolderFloatItem = string | { label: string; value: string }

export interface FolderFloatProps {
  items?: FolderFloatItem[]
  label?: string
  sublabel?: string
  trigger?: 'hover' | 'click'
  defaultOpen?: boolean
  closeOnSelect?: boolean
  physics?: boolean
  drift?: number
  onSelect?: (value: string, index: number) => void
  onOpenChange?: (open: boolean) => void
  folderColor?: string
  frontColor?: string
  paperColor?: string
  itemColor?: string
  itemTextColor?: string
  labelColor?: string
  width?: number
  height?: number
  radius?: number
  spread?: number
  lift?: number
  tilt?: number
  flapAngle?: number
  restAngle?: number
  openDuration?: number
  stagger?: number
  bounce?: number
  className?: string
}

export default function FolderFloat(props: FolderFloatProps): React.JSX.Element
