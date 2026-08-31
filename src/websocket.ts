export function isWebSocketUpgrade(request: Request): boolean {
	return request.method === 'GET'
		&& request.headers.get('Upgrade')?.trim().toLowerCase() === 'websocket'
}

export function upgradeRequiredResponse(): Response {
	return new Response('Expected Upgrade: websocket', {
		status: 426,
		statusText: 'Upgrade Required',
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

export function isOpen(socket: WebSocket | undefined): socket is WebSocket {
	return socket?.readyState === 1
}

export function closeSocket(
	socket: WebSocket | undefined,
	code: number,
	reason: string,
): void {
	if (!socket || socket.readyState !== 1) {
		return
	}
	try {
		socket.close(code, reason)
	} catch {
		// The runtime may close a socket between the readyState check and close().
	}
}
