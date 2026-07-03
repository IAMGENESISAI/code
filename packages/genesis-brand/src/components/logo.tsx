import { type ComponentProps } from "solid-js"
import logoUrl from "../assets/logo.png"
import { PRODUCT_NAME } from "../constants"

const imageClass = (className?: string) => ({ [className ?? ""]: !!className })

export const Mark = (props: { class?: string }) => {
  return (
    <img
      data-component="logo-mark"
      src={logoUrl}
      alt={PRODUCT_NAME}
      classList={imageClass(props.class)}
    />
  )
}

export const Splash = (props: Pick<ComponentProps<"img">, "ref" | "class">) => {
  return (
    <img
      ref={props.ref}
      data-component="logo-splash"
      src={logoUrl}
      alt={PRODUCT_NAME}
      classList={imageClass(props.class)}
    />
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <div
      data-component="logo"
      classList={{
        "inline-flex items-center gap-3": true,
        [props.class ?? ""]: !!props.class,
      }}
    >
      <img src={logoUrl} alt="" class="h-[1.75em] w-[1.75em] shrink-0 object-contain" aria-hidden="true" />
      <span class="font-semibold tracking-tight text-[var(--icon-strong-base)]">{PRODUCT_NAME}</span>
    </div>
  )
}