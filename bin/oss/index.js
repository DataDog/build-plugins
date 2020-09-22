const { Command } = require(`clipanion`);
const fs = require('fs-extra');
const inquirer = require('inquirer');
const path = require('path');
const glob = require('glob');
const chalk = require('chalk');
const { execFile } = require(`child_process`);
const { promisify } = require(`util`);

const templates = require('./templates');

const execFileP = promisify(execFile);
const maxBuffer = 1024 * 1024;

const execute = (cmd, args, cwd) => execFileP(cmd, args, { maxBuffer, cwd });

const ROOT = path.join(__dirname, '../../');

class OSS extends Command {
    name = 'build-plugin';
    getFolders(filePath) {
        return fs.readdirSync(filePath, { withFileTypes: true})
            .filter(f => f.isDirectory())
            .map(f => f.name)
            .sort();
    }

    chooseFolder(folderPath, select = false) {
        const folders = this.getFolders(folderPath);
        const name = select ? 'folders' : 'folder';
        return inquirer.prompt([
            {
                type: select ? 'checkbox' : 'list',
                name,
                message: `Which ${name} do you want to make open source?`,
                choices: folders
            }
        ]);
    }

    async replaceFiles(folderPath, subfolders) {
        const fileTypes = [ 'ts', 'tsx', 'js', 'jsx'];
        const files = glob.sync(`${folderPath}/@(${subfolders.join('|')})/**/*.@(${fileTypes.join('|')})`);

        for (const file of files) {
            const fileName = chalk.green.bold(file.replace(ROOT, ''));
            try {
                const content = await fs.readFile(file, { encoding: 'utf8' });
                if (content.startsWith(templates.header)) {
                    this.context.stdout.write(`Already written in ${fileName}.\n`);
                } else {
                    await fs.writeFile(file, `${templates.header}\n${content}`);
                    this.context.stdout.write(`Processed ${fileName}.\n`);
                }
            } catch (e) {
                this.context.stderr.write(e.toString());
            }
        }
    }

    async applyHeader(name) {
        const subfolders = (await this.chooseFolder(
            ROOT,
            true
        )).folders;

        await this.replaceFiles(ROOT, subfolders);
    }

    async apply3rdPartiesLicenses(name) {
        const { stdout } = await execute('yarn', ['licenses-csv'], ROOT);
        await fs.writeFile(path.join(ROOT, 'LICENSES-3rdparty.csv'), stdout);
    }

    async applyNotice(name) {
        await fs.writeFile(path.join(ROOT, 'NOTICE'), templates.notice(name));
    }

    async applyLicense(name) {
        const { license } = await inquirer.prompt([
            {
                type: 'list',
                name: 'license',
                message: `Which license do you want to use?`,
                choices: Object.keys(templates.licenses)
            }
        ]);
        const licenseContent = await fs.readFile(path.join(__dirname, './_oss/', templates.licenses[license]));
        await fs.writeFile(path.join(ROOT, 'LICENSE'), licenseContent);
    }

    async execute() {
        const name = 'build-plugin';
        await this.applyHeader(name);
        this.context.stdout.write('Done header.\n');
        await this.apply3rdPartiesLicenses(name);
        this.context.stdout.write('Done 3rd parties licenses.\n');
        await this.applyNotice(name);
        this.context.stdout.write('Done notice.\n');
        await this.applyLicense(name);
        this.context.stdout.write('Done license.\n');
    }
}

OSS.addPath(`oss`);

module.exports = [OSS];
