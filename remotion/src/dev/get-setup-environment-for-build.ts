import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoDir = join(packageDir, '..', '..');

export const getBrowserStudioSetupEnvironmentForBuild = () =>
	readFileSync(
		existsSync(join(repoDir, 'packages', 'bundler', 'src', 'setup-environment.ts'))
			? join(repoDir, 'packages', 'bundler', 'src', 'setup-environment.ts')
			: join(packageDir, 'src', 'dev', 'setup-environment.ts'),
		'utf-8',
	);
