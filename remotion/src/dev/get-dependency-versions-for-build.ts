import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

type PackageJson = {
	readonly name?: string;
	readonly version?: string;
	readonly dependencies?: Record<string, string>;
	readonly workspaces?: {
		readonly catalog?: Record<string, string>;
	};
};

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoDir = join(packageDir, '..', '..');
const nodeOnlyStudioDependencies = new Set(['memfs', 'open']);

const standaloneDependencyVersions: Record<string, string> = {
	'@jridgewell/trace-mapping': '0.3.31',
	'@remotion/canvas-capture': '4.0.490',
	'@remotion/media-utils': '4.0.490',
	'@remotion/player': '4.0.490',
	'@remotion/renderer': '4.0.490',
	'@remotion/studio': '4.0.490',
	'@remotion/studio-shared': '4.0.490',
	'@remotion/timeline-utils': '4.0.490',
	'@remotion/web-renderer': '4.0.490',
	'@remotion/zod-types': '4.0.490',
	mediabunny: '1.50.8',
	'react': '19.2.3',
	'react-dom': '19.2.3',
	remotion: '4.0.490',
	semver: '7.5.3',
	zod: '4.3.6',
};

const readPackageJson = (path: string): PackageJson =>
	JSON.parse(readFileSync(path, 'utf-8')) as PackageJson;

const getWorkspacePackageVersions = () => {
	const packageJsonGlob = new Bun.Glob('packages/**/package.json');
	const workspacePackageVersions: Record<string, string> = {};

	for (const packageJsonPath of packageJsonGlob.scanSync({cwd: repoDir})) {
		const packageJson = readPackageJson(join(repoDir, packageJsonPath));

		if (!packageJson.name || !packageJson.version) {
			continue;
		}

		workspacePackageVersions[packageJson.name] = packageJson.version;
	}

	return workspacePackageVersions;
};

const resolveDependencyVersion = ({
	catalog,
	name,
	spec,
	workspacePackageVersions,
}: {
	readonly catalog: Record<string, string>;
	readonly name: string;
	readonly spec: string;
	readonly workspacePackageVersions: Record<string, string>;
}) => {
	if (spec.startsWith('workspace:')) {
		const workspaceVersion = workspacePackageVersions[name];

		if (!workspaceVersion) {
			throw new Error(`Could not find workspace package version for ${name}`);
		}

		return workspaceVersion;
	}

	if (spec === 'catalog:') {
		const catalogVersion = catalog[name];

		if (!catalogVersion) {
			throw new Error(`Could not find catalog version for ${name}`);
		}

		return catalogVersion;
	}

	return spec;
};

export const getBrowserStudioDependencyVersionsForBuild = (): Record<
	string,
	string
> => {
	if (
		!existsSync(join(repoDir, 'package.json')) ||
		!existsSync(join(repoDir, 'packages', 'studio', 'package.json'))
	) {
		return standaloneDependencyVersions;
	}

	const rootPackageJson = readPackageJson(join(repoDir, 'package.json'));
	const studioPackageJson = readPackageJson(
		join(repoDir, 'packages', 'studio', 'package.json'),
	);
	const catalog = rootPackageJson.workspaces?.catalog;

	if (!catalog) {
		throw new Error('Could not find root workspace catalog');
	}

	if (!studioPackageJson.name || !studioPackageJson.version) {
		throw new Error('Could not find @remotion/studio package metadata');
	}

	const dependencySpecs: Record<string, string> = {
		[studioPackageJson.name]: studioPackageJson.version,
		react: 'catalog:',
		'react-dom': 'catalog:',
	};

	for (const [name, spec] of Object.entries(
		studioPackageJson.dependencies ?? {},
	)) {
		if (nodeOnlyStudioDependencies.has(name)) {
			continue;
		}

		dependencySpecs[name] = spec;
	}

	const workspacePackageVersions = getWorkspacePackageVersions();

	return Object.fromEntries(
		Object.entries(dependencySpecs)
			.map(([name, spec]) => [
				name,
				resolveDependencyVersion({
					catalog,
					name,
					spec,
					workspacePackageVersions,
				}),
			])
			.sort(([left], [right]) => left.localeCompare(right)),
	) as Record<string, string>;
};
