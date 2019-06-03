'use strict';

const debug = require('debug')('hoganshim');
const path = require('path');
const fs = require('fs');
const glob = require('glob');
const async = require('async');

const warningBanner = '<div style="background:#f3d5e8;text-align:center;padding:5px">RENDERED WITH HOGAN RENDERER</div>';

const hoganTemplates = {
    partials: {},

    key(name) {
        return name.replace(/\//g, '-').replace(/\.html$/, '');
    },

    loadAll(prefixes, done) {
        async.eachOfSeries(prefixes, (base, prefix, done) => hoganTemplates.load(base, prefix, done), done);
    },

    load(base, prefix, done) {
        if (typeof prefix === 'function') { done = prefix; prefix = null; }

        fs.stat(base, (err, stats) =>{
            if (err) return done(err);

            if (stats.isDirectory())
                return glob(base + '/**/*.{html,pdfxml}', {}, (err, files) => {
                    if (err) return done(err);
                    async.each(files, (filename, done) => {
                        let key = hoganTemplates.key(path.relative(base, filename));
                        if (prefix && prefix !== 'ROOT') key = prefix + '-' + key;
                        hoganTemplates.partials[key] = filename.replace(/\.html$/, '');;
                        done();
                    }, done);
                });

            if (stats.isFile()) {
                let key = prefix || hoganTemplates.key(path.basename(base));
                hoganTemplates.partials[key] = base;
                return done();
            }

            done(new Error(`${base} is not a file or a directory`));
        });
    },

    lookup(name) {
        let key = hoganTemplates.key(name);
        return hoganTemplates.partials[key];
    }
};

const mixinHoganView = (Parent, hoganTemplates) => {
    return class HoganView extends Parent {

        render(options, callback) {
            const render = reason => {
                debug('falling back to parent renderer', this.path, reason);
                super.render(options, callback);
            }

            if (!this.name) return render('No template name');


            // see if this template exists
            let filename = hoganTemplates.lookup(this.name);
            if (!filename) return render('Template not found');

            // if pdf, render straight away
            if (this.ext === '.pdfxml') return this.hoganRender(filename, options, callback);

            // read in template to check for hogan tag
            filename += this.ext;
            debug('Reading template', this.name, filename);
            let template = fs.readFileSync(filename, 'utf8');
            if (!template || !template.match(/{{\s*[<#^>]/)) return render('Not a hogan template');

            return this.hoganRender(filename, options, callback);
        }

        hoganRender(filename, options, callback) {
            console.warn(`Rendering ${this.name} with hogan render`);

            // set up hogan context
            options.partials = options.partials = Object.assign({}, hoganTemplates.partials);
            options._originalLocals.partials = options.partials;
            options.assetPath = '/public';
            let req = { translate: options._originalTranslate };
            let res = { locals: options };

            let ctx = {
                ext: this.ext,
                path: filename,
                name: this.name,
                lookup: file => file
            };

            // add template mixins
            require('hmpo-template-mixins')()(req, res, () => {
                options._originalLocals.translate = res.locals.translate;
                options._originalLocals.t = res.locals.t;
                // render the template
                debug('Rendering', this.name, filename);

                if (this.ext === '.pdfxml') {

                    let pdf  = require('express-hogan-pdf').engine;
    
                    debug('PDF', this.name, this.path, this.ext, filename);
                    pdf.call(ctx, filename, options, callback);

                } else {

                    let hoganRender = require('hogan-express-strict');
    
                    hoganRender.call(ctx, filename, options, (err, rendered) => {
                        if (err) return callback(err);

                        // add warning banner after body tag
                        rendered = rendered.replace(/(<body.*?>)/, '$1' + warningBanner);

                        // respond with rendered HTML
                        callback(null, rendered);
                    });
                }
            });
        }
    };
};

const setup = (app, hoganViews) => {
    let View = app.get('view');
    if (!View) return;

    app.use((req, res, next) => {
        res.locals._originalTranslate = req.translate;
        res.locals._originalLocals = res.locals;
        next();
    });

    hoganViews['govuk-template'] = path.resolve(path.dirname(require.resolve('hmpo-govuk-template')), 'govuk_template.html');
    hoganViews.hmpo = require('hmpo-templates').get('views');

    // load in all hogan template locations into memory
    debug('Loading in hogan views', hoganViews);
    hoganTemplates.loadAll(hoganViews, err => {
        if (err) throw err;
        // mixin render override to express view engine
        View = mixinHoganView(View, hoganTemplates);
        app.set('view', View);

        console.warn('Running with hogan render shim!');
    });
};

module.exports = setup;

