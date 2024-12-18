# `next-on-pages/no-app-nodejs-dynamic-ssg`

When using [`generateStaticParams`](https://nextjs.org/docs/app/api-reference/functions/generate-static-params) you need to either:

- export [`dynamicParams`](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#dynamicparams) set to `false`
- export [`runtime`](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#runtime) set to `true`

This rule makes sure that if you're using `generateStaticParams` at least one of the two export is present.

For more details refer to the [official Khulnasoft Next.js docs](https://developers.khulnasoft.com/pages/framework-guides/nextjs/ssr/troubleshooting/#generatestaticparams).

## ❌ Invalid Code

```js
export async function generateStaticParams() {
                      ~~~~~~~~~~~~~~~~~~~~
  // ...
}

// ...
```

## ✅ Valid Code

```js
export const runtime = 'edge';

export async function generateStaticParams() {
	// ...
}

// ...
```

```js
export const dynamicParams = false;

export async function generateStaticParams() {
	// ...
}

// ...
```
