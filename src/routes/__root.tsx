import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Link, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { Button } from "#/components/ui/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card.tsx";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		links: [
			{
				href: appCss,
				rel: "stylesheet",
			},
		],
		meta: [
			{
				charSet: "utf-8",
			},
			{
				content: "width=device-width, initial-scale=1",
				name: "viewport",
			},
			{
				title: "Saif",
			},
		],
	}),
	notFoundComponent: NotFound,
	shellComponent: RootDocument,
});

function NotFound() {
	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
			<Card className="w-full max-w-sm text-center">
				<CardHeader>
					<CardTitle className="text-4xl">404</CardTitle>
					<CardDescription>This page could not be found.</CardDescription>
				</CardHeader>
				<CardContent>
					<Button asChild={true}>
						<Link to="/">Go home</Link>
					</Button>
				</CardContent>
			</Card>
		</main>
	);
}

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<header className="border-b">
					<nav aria-label="Primary" className="mx-auto flex max-w-5xl items-center gap-2 p-4">
						<Button asChild={true} size="sm" variant="ghost">
							<Link activeProps={{ className: "bg-accent text-accent-foreground" }} to="/">
								Saif
							</Link>
						</Button>
						<Button asChild={true} size="sm" variant="ghost">
							<Link
								activeProps={{ className: "bg-accent text-accent-foreground" }}
								to="/playground"
							>
								Playground
							</Link>
						</Button>
						<Button asChild={true} size="sm" variant="ghost">
							<Link activeProps={{ className: "bg-accent text-accent-foreground" }} to="/dashboard">
								Dashboard
							</Link>
						</Button>
					</nav>
				</header>
				<div id="root-content">{children}</div>
				<div id="portal-root" />
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
