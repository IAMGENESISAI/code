import { Link, Meta } from "@solidjs/meta"
import { PRODUCT_NAME } from "@opencode-ai/genesis-brand/constants"

export const Favicon = () => {
  return (
    <>
      <Link rel="icon" type="image/png" href="/android-chrome-192x192.png" sizes="192x192" />
      <Link rel="icon" type="image/png" href="/favicon-96x96-v3.png" sizes="96x96" />
      <Link rel="apple-touch-icon" sizes="192x192" href="/android-chrome-192x192.png" />
      <Link rel="manifest" href="/site.webmanifest" />
      <Meta name="apple-mobile-web-app-title" content={PRODUCT_NAME} />
    </>
  )
}
