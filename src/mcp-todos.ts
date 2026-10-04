import { existsSync, readFileSync, writeFileSync } from "node:fs";

const todosPath = "./mcp-todos.json";

export interface Todo {
	id: number;
	title: string;
}

function isTodo(value: unknown): value is Todo {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as { id?: unknown; title?: unknown };
	return typeof record.id === "number" && typeof record.title === "string";
}

function defaultTodos(): Todo[] {
	return [
		{
			id: 1,
			title: "Buy groceries",
		},
	];
}

function loadTodos(): Todo[] {
	if (!existsSync(todosPath)) {
		return defaultTodos();
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(todosPath, "utf8"));
		if (Array.isArray(parsed) && parsed.every(isTodo)) {
			return [...parsed];
		}
	} catch {
		// A corrupt store must not crash every importer; start fresh.
	}
	return defaultTodos();
}

// In-memory todos storage
const todos: Todo[] = loadTodos();

function persistTodos(): void {
	writeFileSync(todosPath, JSON.stringify(todos, null, 2));
}

// Subscription callbacks per userID
let subscribers: ((items: Todo[]) => void)[] = [];

// Get the todos for a user
export function getTodos(): Todo[] {
	return [...todos];
}

// Add an item to the todos
export function addTodo(title: string): Todo {
	const todo: Todo = { id: todos.length + 1, title };
	todos.push(todo);
	persistTodos();
	notifySubscribers();
	return todo;
}

// Delete every todo; returns how many were removed
export function clearTodos(): number {
	const deleted = todos.length;
	todos.length = 0;
	persistTodos();
	notifySubscribers();
	return deleted;
}

// Subscribe to cart changes for a user
export function subscribeToTodos(callback: (items: Todo[]) => void) {
	subscribers.push(callback);
	callback([...todos]);
	return () => {
		subscribers = subscribers.filter((cb) => cb !== callback);
	};
}

// Notify all subscribers of a user's cart
function notifySubscribers() {
	for (const cb of subscribers) {
		try {
			cb([...todos]);
		} catch {
			// A misbehaving subscriber must not break notifications to the others.
		}
	}
}
