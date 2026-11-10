import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
const buttonVariants = cva('button', {variants:{variant:{primary:'button-primary',secondary:'button-secondary',danger:'button-danger'}},defaultVariants:{variant:'secondary'}})
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({variant,className,...props},ref)=><button ref={ref} className={cn(buttonVariants({variant}),className)} {...props}/>)
Button.displayName='Button'
