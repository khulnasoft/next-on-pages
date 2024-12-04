import { parse } from 'cookie';
import type { MatchPCREResult, MatchedSetHeaders } from './utils';
import { isLocaleTrailingSlashRegex, parseAcceptLanguage } from './utils';
import {
	applyHeaders,
	applyPCREMatches,
	applySearchParams,
	checkhasField,
	getNextPhase,
	isUrl,
	matchPCRE,
	runOrFetchBuildOutputItem,
} from './utils';
import type { RequestContext } from '../../src/utils/requestContext';

export type CheckRouteStatus = 'skip' | 'next' | 'done' | 'error';
export type CheckPhaseStatus = Extract<CheckRouteStatus, 'error' | 'done'>;

/**
 * The routes matcher is used to match a request to a route and run the route's middleware.
 */
export class RoutesMatcher {
	/** URL from the request to match */
	private url: URL;
	/** Cookies from the request to match */
	private cookies: Record<string, string>;
	/** Wildcard match from the Vercel build output config */
	private wildcardMatch: VercelWildCard | undefined;

	/** Path for the matched route */
	public path: string;
	/** Status for the response object */
	public status: number | undefined;
	/** Headers for the response object */
	public headers: MatchedSetHeaders;
	/** Search params for the response object */
	public searchParams: URLSearchParams;
	/** Custom response body from middleware */
	public body: BodyInit | undefined | null;

	/** Counter for how many times the function to check a phase has been called */
	public checkPhaseCounter;
	/** Tracker for the middleware that have been invoked in a phase */
	private middlewareInvoked: string[];
	/** Locales found during routing */
	public locales: Set<string>;

	/**
	 * Creates a new instance of a request matcher.
	 *
	 * The matcher is used to match a request to a route and run the route's middleware.
	 *
	 * @param routes The processed Vercel build output config routes.
	 * @param output Vercel build output.
	 * @param reqCtx Request context object; request object, assets fetcher, and execution context.
	 * @param buildMetadata Metadata generated by the next-on-pages build process.
	 * @param wildcardConfig Wildcard options from the Vercel build output config.
	 * @returns The matched set of path, status, headers, and search params.
	 */
	constructor(
		/** Processed routes from the Vercel build output config. */
		private routes: ProcessedVercelRoutes,
		/** Vercel build output. */
		private output: VercelBuildOutput,
		/** Request Context object for the request to match */
		private reqCtx: RequestContext,
		buildMetadata: NextOnPagesBuildMetadata,
		wildcardConfig?: VercelWildcardConfig,
	) {
		this.url = new URL(reqCtx.request.url);
		this.cookies = parse(reqCtx.request.headers.get('cookie') || '');

		this.path = this.url.pathname || '/';
		this.headers = { normal: new Headers(), important: new Headers() };
		this.searchParams = new URLSearchParams();
		applySearchParams(this.searchParams, this.url.searchParams);

		this.checkPhaseCounter = 0;
		this.middlewareInvoked = [];

		this.wildcardMatch = wildcardConfig?.find(
			w => w.domain === this.url.hostname,
		);

		this.locales = new Set(buildMetadata.collectedLocales);
	}

	/**
	 * Checks if a Vercel source route from the build output config matches the request.
	 *
	 * @param route Build output config source route.
	 * @param checkStatus Whether to check the status code of the route.
	 * @returns The source path match result if the route matches, otherwise `undefined`.
	 */
	private checkRouteMatch(
		route: VercelSource,
		{
			checkStatus,
			checkIntercept,
		}: { checkStatus: boolean; checkIntercept: boolean },
	): { routeMatch: MatchPCREResult; routeDest?: string } | undefined {
		const srcMatch = matchPCRE(route.src, this.path, route.caseSensitive);
		if (!srcMatch.match) return;

		// One of the HTTP `methods` conditions must be met - skip if not met.
		if (
			route.methods &&
			!route.methods
				.map(m => m.toUpperCase())
				.includes(this.reqCtx.request.method.toUpperCase())
		) {
			return;
		}

		const hasFieldProps = {
			url: this.url,
			cookies: this.cookies,
			headers: this.reqCtx.request.headers,
			routeDest: route.dest,
		};

		// All `has` conditions must be met - skip if one is not met.
		if (
			route.has?.find(has => {
				const result = checkhasField(has, hasFieldProps);
				if (result.newRouteDest) {
					// If the `has` condition had a named capture to update the destination, update it.
					hasFieldProps.routeDest = result.newRouteDest;
				}
				return !result.valid;
			})
		) {
			return;
		}

		// All `missing` conditions must not be met - skip if one is met.
		if (route.missing?.find(has => checkhasField(has, hasFieldProps).valid)) {
			return;
		}

		// Required status code must match (i.e. for error routes) - skip if not met.
		if (checkStatus && route.status !== this.status) {
			return;
		}

		if (checkIntercept && route.dest) {
			const interceptRouteRegex = /\/(\(\.+\))+/;
			const destIsIntercept = interceptRouteRegex.test(route.dest);
			const pathIsIntercept = interceptRouteRegex.test(this.path);

			// If the new destination is an intercept route, only allow it if the current path is also
			// an intercept route.
			if (destIsIntercept && !pathIsIntercept) {
				return;
			}
		}

		return { routeMatch: srcMatch, routeDest: hasFieldProps.routeDest };
	}

	/**
	 * Processes the response from running a middleware function.
	 *
	 * Handles rewriting the URL and applying redirects, response headers, and overriden request headers.
	 *
	 * @param resp Middleware response object.
	 */
	private processMiddlewareResp(resp: Response): void {
		const overrideKey = 'x-middleware-override-headers';
		const overrideHeader = resp.headers.get(overrideKey);
		if (overrideHeader) {
			const overridenHeaderKeys = new Set(
				overrideHeader.split(',').map(h => h.trim()),
			);

			for (const key of overridenHeaderKeys.keys()) {
				const valueKey = `x-middleware-request-${key}`;
				const value = resp.headers.get(valueKey);

				if (this.reqCtx.request.headers.get(key) !== value) {
					if (value) {
						this.reqCtx.request.headers.set(key, value);
					} else {
						this.reqCtx.request.headers.delete(key);
					}
				}

				resp.headers.delete(valueKey);
			}

			resp.headers.delete(overrideKey);
		}

		const rewriteKey = 'x-middleware-rewrite';
		const rewriteHeader = resp.headers.get(rewriteKey);

		if (rewriteHeader) {
			const newUrl = new URL(rewriteHeader, this.url);

			const rewriteIsExternal = this.url.hostname !== newUrl.hostname;

			this.path = rewriteIsExternal ? `${newUrl}` : newUrl.pathname;

			applySearchParams(this.searchParams, newUrl.searchParams);

			resp.headers.delete(rewriteKey);
		}

		const middlewareNextKey = 'x-middleware-next';
		const middlewareNextHeader = resp.headers.get(middlewareNextKey);
		if (middlewareNextHeader) {
			resp.headers.delete(middlewareNextKey);
		} else if (!rewriteHeader && !resp.headers.has('location')) {
			// We should set the final response body and status to the middleware's if it does not want
			// to continue and did not rewrite/redirect the URL.
			this.body = resp.body;
			this.status = resp.status;
		} else if (
			resp.headers.has('location') &&
			resp.status >= 300 &&
			resp.status < 400
		) {
			this.status = resp.status;
		}

		// copy to the request object the headers that have been set by the middleware
		applyHeaders(this.reqCtx.request.headers, resp.headers);

		applyHeaders(this.headers.normal, resp.headers);
		this.headers.middlewareLocation = resp.headers.get('location');
	}

	/**
	 * Runs the middleware function for a route if it exists.
	 *
	 * @param path Path to the route's middleware function.
	 * @returns Whether the middleware function was run successfully.
	 */
	private async runRouteMiddleware(path?: string): Promise<boolean> {
		// If there is no path, return true as it did not result in an error.
		if (!path) return true;

		const item = path && this.output[path];
		if (!item || item.type !== 'middleware') {
			// The middleware function could not be found. Set the status to 500 and bail out.
			this.status = 500;
			return false;
		}

		const resp = await runOrFetchBuildOutputItem(item, this.reqCtx, {
			path: this.path,
			searchParams: this.searchParams,
			headers: this.headers,
			status: this.status,
		});
		this.middlewareInvoked.push(path);

		if (resp.status === 500) {
			// The middleware function threw an error. Set the status and bail out.
			this.status = resp.status;
			return false;
		}

		this.processMiddlewareResp(resp);
		return true;
	}

	/**
	 * Resets the response status and headers if the route should override them.
	 *
	 * @param route Build output config source route.
	 */
	private applyRouteOverrides(route: VercelSource): void {
		if (!route.override) return;

		this.status = undefined;
		this.headers.normal = new Headers();
		this.headers.important = new Headers();
	}

	/**
	 * Applies the route's headers for the response object.
	 *
	 * @param route Build output config source route.
	 * @param srcMatch Matches from the PCRE matcher.
	 * @param captureGroupKeys Named capture group keys from the PCRE matcher.
	 */
	private applyRouteHeaders(
		route: VercelSource,
		srcMatch: RegExpMatchArray,
		captureGroupKeys: string[],
	): void {
		if (!route.headers) return;

		applyHeaders(this.headers.normal, route.headers, {
			match: srcMatch,
			captureGroupKeys,
		});

		if (route.important) {
			applyHeaders(this.headers.important, route.headers, {
				match: srcMatch,
				captureGroupKeys,
			});
		}
	}

	/**
	 * Applies the route's status code for the response object.
	 *
	 * @param route Build output config source route.
	 */
	private applyRouteStatus(route: VercelSource): void {
		if (!route.status) return;

		this.status = route.status;
	}

	/**
	 * Applies the route's destination for the matching the path to the Vercel build output.
	 *
	 * Applies any wildcard matches to the destination.
	 *
	 * @param route Build output config source route.
	 * @param srcMatch Matches from the PCRE matcher.
	 * @param captureGroupKeys Named capture group keys from the PCRE matcher.
	 * @returns The previous path for the route before applying the destination.
	 */
	private applyRouteDest(
		route: VercelSource,
		srcMatch: RegExpMatchArray,
		captureGroupKeys: string[],
	): string {
		if (!route.dest) return this.path;

		const prevPath = this.path;
		let processedDest = route.dest;

		// Apply wildcard matches before PCRE matches
		if (this.wildcardMatch && /\$wildcard/.test(processedDest)) {
			processedDest = processedDest.replace(
				/\$wildcard/g,
				this.wildcardMatch.value,
			);
		}

		this.path = applyPCREMatches(processedDest, srcMatch, captureGroupKeys);

		// NOTE: Special handling for `/index` RSC routes. Sometimes the Vercel build output config
		// has a record to rewrite `^/` to `/index.rsc`, however, this will hit requests to pages
		// that aren't `/`. In this case, we should check that the previous path is `/`. This should
		// not match requests to `/__index.prefetch.rsc` as Vercel handles those requests missing in
		// later phases.
		// https://github.com/vercel/vercel/blob/31daff/packages/next/src/utils.ts#L3321
		const isRscIndex = /\/index\.rsc$/i.test(this.path);
		const isPrevAbsoluteIndex = /^\/(?:index)?$/i.test(prevPath);
		const isPrevPrefetchRscIndex = /^\/__index\.prefetch\.rsc$/i.test(prevPath);
		if (isRscIndex && !isPrevAbsoluteIndex && !isPrevPrefetchRscIndex) {
			this.path = prevPath;
		}

		// NOTE: Special handling for `.rsc` requests. If the Vercel CLI failed to generate an RSC version
		// of the page and the build output config has a record mapping the request to the RSC variant, we
		// should strip the `.rsc` extension from the path. We do not strip the extension if the request is
		// to a `.prefetch.rsc` file as Vercel handles those requests missing in later phases.
		const isRsc = /\.rsc$/i.test(this.path);
		const isPrefetchRsc = /\.prefetch\.rsc$/i.test(this.path);
		const pathExistsInOutput = this.path in this.output;
		if (isRsc && !isPrefetchRsc && !pathExistsInOutput) {
			this.path = this.path.replace(/\.rsc/i, '');
		}

		// Merge search params for later use when serving a response.
		const destUrl = new URL(this.path, this.url);
		applySearchParams(this.searchParams, destUrl.searchParams);

		// If the new dest is not an URL, update the path with the path from the URL.
		if (!isUrl(this.path)) this.path = destUrl.pathname;

		return prevPath;
	}

	/**
	 * Applies the route's redirects for locales and internationalization.
	 *
	 * @param route Build output config source route.
	 */
	private applyLocaleRedirects(route: VercelSource): void {
		if (!route.locale?.redirect) return;

		// Automatic locale detection is only supposed to occur at the root. However, the build output
		// sometimes uses `/` as the regex instead of `^/$`. So, we should check if the `route.src` is
		// equal to the path if it is not a regular expression, to determine if we are at the root.
		// https://nextjs.org/docs/pages/building-your-application/routing/internationalization#automatic-locale-detection
		const srcIsRegex = /^\^(.)*$/.test(route.src);
		if (!srcIsRegex && route.src !== this.path) return;

		// If we already have a location header set, we might have found a locale redirect earlier.
		if (this.headers.normal.has('location')) return;

		const {
			locale: { redirect: redirects, cookie: cookieName },
		} = route;

		const cookieValue = cookieName && this.cookies[cookieName];
		const cookieLocales = parseAcceptLanguage(cookieValue ?? '');

		const headerLocales = parseAcceptLanguage(
			this.reqCtx.request.headers.get('accept-language') ?? '',
		);

		// Locales from the cookie take precedence over the header.
		const locales = [...cookieLocales, ...headerLocales];

		const redirectLocales = locales
			.map(locale => redirects[locale])
			.filter(Boolean) as string[];

		const redirectValue = redirectLocales[0];
		if (redirectValue) {
			const needsRedirecting = !this.path.startsWith(redirectValue);
			if (needsRedirecting) {
				this.headers.normal.set('location', redirectValue);
				this.status = 307;
			}
			return;
		}
	}

	/**
	 * Modifies the source route's `src` regex to be friendly with previously found locale's in the
	 * `miss` phase.
	 *
	 * There is a source route generated for rewriting `/{locale}/*` to `/*` when no file was found
	 * for the path. This causes issues when using an SSR function for the index page as the request
	 * to `/{locale}` will not be caught by the regex. Therefore, the regex needs to be updated to
	 * also match requests to solely `/{locale}` when the path has no trailing slash.
	 *
	 * @param route Build output config source route.
	 * @param phase Current phase of the routing process.
	 * @returns The route with the locale friendly regex.
	 */
	private getLocaleFriendlyRoute(
		route: VercelSource,
		phase: VercelPhase,
	): VercelSource {
		if (!this.locales || phase !== 'miss') {
			return route;
		}

		if (isLocaleTrailingSlashRegex(route.src, this.locales)) {
			return {
				...route,
				src: route.src.replace(/\/\(\.\*\)\$$/, '(?:/(.*))?$'),
			};
		}

		return route;
	}

	/**
	 * Checks a route to see if it matches the current request.
	 *
	 * @param phase Current phase of the routing process.
	 * @param route Build output config source route.
	 * @returns The status from checking the route.
	 */
	private async checkRoute(
		phase: VercelPhase,
		rawRoute: VercelSource,
	): Promise<CheckRouteStatus> {
		const localeFriendlyRoute = this.getLocaleFriendlyRoute(rawRoute, phase);
		const { routeMatch, routeDest } =
			this.checkRouteMatch(localeFriendlyRoute, {
				checkStatus: phase === 'error',
				// The build output config correctly maps relevant request paths to be intercepts in the
				// `none` phase, while the `rewrite` phase can contain entries that rewrite to an intercept
				// that matches requests that are not actually intercepts, causing a 404.
				checkIntercept: phase === 'rewrite',
			}) ?? {};

		const route: VercelSource = { ...localeFriendlyRoute, dest: routeDest };

		// If this route doesn't match, continue to the next one.
		if (!routeMatch?.match) return 'skip';

		// If this route is a middleware route, check if it has already been invoked.
		if (
			route.middlewarePath &&
			this.middlewareInvoked.includes(route.middlewarePath)
		) {
			return 'skip';
		}

		const { match: srcMatch, captureGroupKeys } = routeMatch;

		// If this route overrides, replace the response headers and status.
		this.applyRouteOverrides(route);

		// If this route has a locale, apply the redirects for it.
		this.applyLocaleRedirects(route);

		// Call and process the middleware if this is a middleware route.
		const success = await this.runRouteMiddleware(route.middlewarePath);
		if (!success) return 'error';
		// If the middleware set a response body or resulted in a redirect, we are done.
		if (this.body !== undefined || this.headers.middlewareLocation) {
			return 'done';
		}

		// Update final headers with the ones from this route.
		this.applyRouteHeaders(route, srcMatch, captureGroupKeys);

		// Update the status code if this route has one.
		this.applyRouteStatus(route);

		// Update the path with the new destination.
		const prevPath = this.applyRouteDest(route, srcMatch, captureGroupKeys);

		// If `check` is required and the path isn't a URL, check it again.
		if (route.check && !isUrl(this.path)) {
			if (prevPath === this.path) {
				// NOTE: If the current/rewritten path is the same as the one that entered the phase, it
				// can cause an infinite loop. Therefore, we should just set the status to `404` instead
				// when we are in the `miss` phase. Otherwise, we should continue to the next phase.
				// This happens with invalid `/_next/static/...` and `/_next/data/...` requests.

				if (phase !== 'miss') {
					return this.checkPhase(getNextPhase(phase));
				}

				this.status = 404;
			} else if (phase === 'miss') {
				// When in the `miss` phase, enter `filesystem` if the file is not in the build output. This
				// avoids rewrites in `none` that do the opposite of those in `miss`, and would cause infinite
				// loops (e.g. i18n). If it is in the build output, remove a potentially applied `404` status.
				if (
					!(this.path in this.output) &&
					!(this.path.replace(/\/$/, '') in this.output)
				) {
					return this.checkPhase('filesystem');
				}

				if (this.status === 404) {
					this.status = undefined;
				}
			} else {
				// In all other instances, we need to enter the `none` phase so we can ensure that requests
				// for the `RSC` variant of pages are served correctly.
				return this.checkPhase('none');
			}
		}

		// If we found a match and shouldn't continue finding matches, break out of the loop.
		if (!route.continue) {
			return 'done';
		}

		// If the route is a redirect then we're actually done
		const isRedirect =
			route.status && route.status >= 300 && route.status <= 399;
		if (isRedirect) {
			return 'done';
		}

		return 'next';
	}

	/**
	 * Checks a phase from the routing process to see if any route matches the current request.
	 *
	 * @param phase Current phase for routing.
	 * @returns The status from checking the phase.
	 */
	private async checkPhase(phase: VercelPhase): Promise<CheckPhaseStatus> {
		if (this.checkPhaseCounter++ >= 50) {
			// eslint-disable-next-line no-console
			console.error(
				`Routing encountered an infinite loop while checking ${this.url.pathname}`,
			);
			this.status = 500;
			return 'error';
		}

		// Reset the middleware invoked list as this is a new phase.
		this.middlewareInvoked = [];
		let shouldContinue = true;

		for (const route of this.routes[phase]) {
			const result = await this.checkRoute(phase, route);

			if (result === 'error') {
				return 'error';
			}

			if (result === 'done') {
				shouldContinue = false;
				break;
			}
		}

		// In the `hit` phase or for external urls/redirects/middleware responses, return the match.
		if (
			phase === 'hit' ||
			isUrl(this.path) ||
			this.headers.normal.has('location') ||
			!!this.body
		) {
			return 'done';
		}

		if (phase === 'none') {
			// applications using the Pages router with i18n plus a catch-all root route
			// redirect all requests (including /api/ ones) to the catch-all route, the only
			// way to prevent this erroneous behavior is to remove the locale here if the
			// path without the locale exists in the vercel build output
			for (const locale of this.locales) {
				const localeRegExp = new RegExp(`/${locale}(/.*)`);
				const match = this.path.match(localeRegExp);
				const pathWithoutLocale = match?.[1];
				if (pathWithoutLocale && pathWithoutLocale in this.output) {
					this.path = pathWithoutLocale;
					break;
				}
			}
		}

		let pathExistsInOutput = this.path in this.output;

		// paths could incorrectly not be detected as existing in the output due to the `trailingSlash` setting
		// in `next.config.mjs`, so let's check for that here and update the path in such case
		if (!pathExistsInOutput && this.path.endsWith('/')) {
			const newPath = this.path.replace(/\/$/, '');
			pathExistsInOutput = newPath in this.output;
			if (pathExistsInOutput) {
				this.path = newPath;
			}
		}

		// In the `miss` phase, set status to 404 if no path was found and it isn't an error code.
		if (phase === 'miss' && !pathExistsInOutput) {
			const should404 = !this.status || this.status < 400;
			this.status = should404 ? 404 : this.status;
		}

		let nextPhase: VercelHandleValue = 'miss';
		if (pathExistsInOutput || phase === 'miss' || phase === 'error') {
			// If the route exists, enter the `hit` phase. For `miss` and `error` phases, enter the `hit`
			// phase to update headers (e.g. `x-matched-path`).
			nextPhase = 'hit';
		} else if (shouldContinue) {
			nextPhase = getNextPhase(phase);
		}

		return this.checkPhase(nextPhase);
	}

	/**
	 * Runs the matcher for a phase.
	 *
	 * @param phase The phase to start matching routes from.
	 * @returns The status from checking for matches.
	 */
	public async run(
		phase: Extract<VercelPhase, 'none' | 'error'> = 'none',
	): Promise<CheckPhaseStatus> {
		// Reset the counter for each run.
		this.checkPhaseCounter = 0;
		const result = await this.checkPhase(phase);

		// Update status to redirect user to external URL.
		if (
			this.headers.normal.has('location') &&
			(!this.status || this.status < 300 || this.status >= 400)
		) {
			this.status = 307;
		}

		return result;
	}
}