import init, { HTMLRewriter as RawHTMLRewriter } from '../dist/html_rewriter.js'

import { DocumentHandlers, ElementHandlers } from './types'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// console.log(wasm)

export function HTMLRewriterWrapper(initPromise: Promise<any>) {
    return class HTMLRewriter {
        initPromise: Promise<void> = initPromise

        constructor(options: any = {}) {}

        elementHandlers: [selector: string, handlers: ElementHandlers][] = []
        documentHandlers: DocumentHandlers[] = []

        on(selector: string, handlers: ElementHandlers): this {
            this.elementHandlers.push([selector, handlers])
            return this
        }

        onDocument(handlers: DocumentHandlers): this {
            this.documentHandlers.push(handlers)
            return this
        }
        transform(response: Response): Response {
            const body = response.body as ReadableStream<Uint8Array> | null
            // HTMLRewriter doesn't run the end handler if the body is null, so it's
            // pointless to setup the transform stream.
            if (body === null) return new Response(body, response)

            if (response instanceof Response) {
                // Make sure we validate chunks are BufferSources and convert them to
                // Uint8Arrays as required by the Rust glue code.
                response = new Response(response.body, response)
            }

            let rewriter: RawHTMLRewriter
            const transformStream = new TransformStream<Uint8Array, Uint8Array>(
                {
                    start: async (controller) => {
                        // Create a rewriter instance for this transformation that writes its
                        // output to the transformed response's stream. Note that each
                        // BaseHTMLRewriter can only be used once.
                        await this.initPromise
                        rewriter = new RawHTMLRewriter(
                            (chunk: any) => {
                                // enqueue will throw on empty chunks
                                if (chunk.length !== 0)
                                    controller.enqueue(chunk)
                            },
                            { enableEsiTags: false },
                        )
                        // Add all registered handlers
                        for (const [selector, handlers] of this
                            .elementHandlers) {
                            rewriter.on(selector, handlers)
                        }
                        for (const handlers of this.documentHandlers) {
                            rewriter.onDocument(handlers)
                        }
                    },
                    // The finally() below will ensure the rewriter is always freed.
                    // chunk is guaranteed to be a Uint8Array as we're using the
                    // @miniflare/core Response class, which transforms to a byte stream.
                    transform: (chunk) => rewriter.write(chunk),
                    flush: () => rewriter.end(),
                },
            )
            const promise = body.pipeTo(transformStream.writable)
            promise
                .catch((e) => {
                    console.error(`Error in HTMLRewriter:`, e)
                    return null
                })
                .finally(() => rewriter?.free())

            // Return a response with the transformed body, copying over headers, etc
            const res = new Response(transformStream.readable, response)
            // If Content-Length is set, it's probably going to be wrong, since we're
            // rewriting content, so remove it
            res.headers.delete('Content-Length')
            return res
        }
    }
}
