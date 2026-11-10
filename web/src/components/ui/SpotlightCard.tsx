import { useState, type HTMLAttributes, type MouseEvent } from 'react'
import { cn } from '../../lib/utils'
/** Pointer spotlight treatment adapted from the 21st.dev Spotlight Card pattern. */
export function SpotlightCard({className,style,onMouseMove,...props}:HTMLAttributes<HTMLElement>) {
  const [point,setPoint]=useState({x:50,y:50})
  function move(event:MouseEvent<HTMLElement>){const r=event.currentTarget.getBoundingClientRect();setPoint({x:(event.clientX-r.left)/r.width*100,y:(event.clientY-r.top)/r.height*100});onMouseMove?.(event)}
  return <article className={cn('spotlight-card',className)} style={{...style,backgroundImage:`radial-gradient(340px circle at ${point.x}% ${point.y}%, rgba(127,230,188,.12), transparent 75%)`}} onMouseMove={move} {...props}/>
}
