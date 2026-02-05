import { saveSettingsDebounced, getRequestHeaders, callPopup } from '../../../../script.js';
import { getContext, extension_settings, renderExtensionTemplate } from '../../../extensions.js';

import {
    DEBUG_PREFIX,
    VRM_MODEL_FOLDER,
    CLASSIFY_EXPRESSIONS,
    HITBOXES,
    DEFAULT_LIGHT_COLOR,
    DEFAULT_LIGHT_INTENSITY,
    DEFAULT_CUSTOM_EXPRESSIONS
} from './constants.js';

import {
    loadScene,
    setModel,
    unloadModel,
    getVRM,
    setExpression,
    setMotion,
    setMotionSequence,
    clearAnimationSequence,
    updateModel,
    clearModelCache,
    clearAnimationCache,
    loadAllModels,
    setLight,
    setCursorTracking
} from "./vrm.js";

import {
    currentChatMembers,
    delay,
    loadAnimationUi,
} from './utils.js';
import { exp } from './lib/jsm/nodes/Nodes.js';

export {
    onEnabledClick,
    onFollowCameraClick,
    onFollowCursorClick,
    onBlinkClick,
    onNaturalIdleClick,
    onTtsLipsSyncClick,
    onHitboxesClick,
    onAutoSendHitboxMessageClick,
    onLockModelsClick,
    onModelCacheClick,
    onAnimationCacheClick,
    onLightChange,
    onLightColorResetClick,
    onLightIntensityResetClick,
    onShowGridClick,
    onFunctionToolsClick,
    onCharacterChange,
    onCharacterRefreshClick,
    onCharacterRemoveClick,
    updateCharactersList,
    updateCharactersListOnce,
    updateCharactersModels,
    onModelRefreshClick,
    onModelChange,
    onModelResetClick,
    onModelScaleChange,
    onModelPositionChange,
    onModelRotationChange,
    onAnimationMappingChange,
    models_files,
    animations_files,
    onSequencePlayClick,
    onSequenceClearClick,
    onBlendShapeAddClick,
    loadBlendShapeMappingUi
};

let characters_list = [];

let models_files = [];
let models_files_label = [];

let animations_files = [];
let animations_groups = [];


async function onEnabledClick() {
    extension_settings.vrm.enabled = $('#vrm_enabled_checkbox').is(':checked');
    $('#vrm_character_select').val("none");
    $('#vrm_model_select').val("none");
    saveSettingsDebounced();

    await loadScene();
    if(extension_settings.vrm.enabled)
        await loadAllModels(currentChatMembers());
}

async function onFollowCameraClick() {
    extension_settings.vrm.follow_camera = $('#vrm_follow_camera_checkbox').is(':checked');
    saveSettingsDebounced();
}

async function onFollowCursorClick() {
    extension_settings.vrm.follow_cursor = $('#vrm_follow_cursor_checkbox').is(':checked');
    setCursorTracking(extension_settings.vrm.follow_cursor);
    saveSettingsDebounced();
}

async function onBlinkClick() {
    extension_settings.vrm.blink = $('#vrm_blink_checkbox').is(':checked');
    saveSettingsDebounced();
    if(extension_settings.vrm.enabled)
        await loadAllModels(currentChatMembers());
}

async function onNaturalIdleClick() {
    extension_settings.vrm.natural_idle = $('#vrm_natural_idle_checkbox').is(':checked');
    saveSettingsDebounced();
}

async function onTtsLipsSyncClick() {
    extension_settings.vrm.tts_lips_sync = $('#vrm_tts_lips_sync_checkbox').is(':checked');
    saveSettingsDebounced();
}

async function onHitboxesClick() {
    extension_settings.vrm.hitboxes = $('#vrm_hitboxes_checkbox').is(':checked');
    saveSettingsDebounced();
    clearModelCache();
    if(extension_settings.vrm.enabled)
        await loadAllModels(currentChatMembers());
}

async function onAutoSendHitboxMessageClick() {
    extension_settings.vrm.auto_send_hitbox_message = $('#vrm_auto_send_hitbox_message_checkbox').is(':checked');
    saveSettingsDebounced();
}

async function onLockModelsClick() {
    extension_settings.vrm.lock_models = $('#vrm_lock_models_checkbox').is(':checked');
    saveSettingsDebounced();
}

async function onModelCacheClick() {
    extension_settings.vrm.models_cache = $('#vrm_models_cache_checkbox').is(':checked');
    saveSettingsDebounced();
    if (!extension_settings.vrm.models_cache)
        clearModelCache()
    else
        loadAllModels(currentChatMembers());
}

async function onAnimationCacheClick() {
    extension_settings.vrm.animations_cache = $('#vrm_animations_cache_checkbox').is(':checked');
    saveSettingsDebounced();
    if (!extension_settings.vrm.animations_cache)
        clearAnimationCache();
    else
        loadAllModels(currentChatMembers());
}

async function onLightChange() {
    extension_settings.vrm.light_color = $('#vrm_light_color').val();
    extension_settings.vrm.light_intensity = Number($('#vrm_light_intensity').val());
    $('#vrm_light_intensity_value').text(extension_settings.vrm.light_intensity);
    saveSettingsDebounced();

    setLight(extension_settings.vrm.light_color, extension_settings.vrm.light_intensity);
}

async function onLightColorResetClick() {
    $("#vrm_light_color").val(DEFAULT_LIGHT_COLOR);
    onLightChange();
}

async function onLightIntensityResetClick() {
    $("#vrm_light_intensity").val(DEFAULT_LIGHT_INTENSITY);
    onLightChange();
}

async function onShowGridClick() {
    extension_settings.vrm.show_grid = $('#vrm_show_grid_checkbox').is(':checked');
    saveSettingsDebounced();
}

async function onFunctionToolsClick() {
    extension_settings.vrm.function_tools = $('#vrm_function_tools_checkbox').is(':checked');
    saveSettingsDebounced();
    
    // Re-register or unregister tools based on the new setting
    const context = getContext();
    if (context.ToolManager) {
        if (extension_settings.vrm.function_tools) {
            console.debug(DEBUG_PREFIX, 'Function tools enabled - tools will be registered on next load');
        } else {
            console.debug(DEBUG_PREFIX, 'Function tools disabled - unregistering all VRM tools');
            // Unregister all VRM tools
            const tools = ['SetVRMExpression', 'SetVRMMotion', 'PlayVRMAnimationSequence', 'ClearVRMAnimationSequence', 'SetVRMLightColor', 'SetVRMLightIntensity', 'ListVRMMotions'];
            tools.forEach(tool => {
                try {
                    context.unregisterFunctionTool(tool);
                } catch (e) {
                    // Tool might not be registered, ignore error
                }
            });
        }
    }
}

async function onCharacterChange() {
    const character = String($('#vrm_character_select').val());

    $('#vrm_model_div').hide();
    $('#vrm_model_settings').hide();

    if (character == 'none') {
        return;
    }

    $('#vrm_model_select')
        .find('option')
        .remove()
        .end()
        .append('<option value="none">None</option>')
        .val('none');

    for (const i of models_files_label) {
        //console.debug(DEBUG_PREFIX,"DEBUG",i)
        const model_folder = i[0];
        const model_settings_path = i[1];
        $('#vrm_model_select').append(new Option(model_folder, model_settings_path));
    }
    

    if (extension_settings.vrm.character_model_mapping[character] !== undefined) {
        $('#vrm_model_select').val(extension_settings.vrm.character_model_mapping[character]);
        $('#vrm_model_settings').show();
        loadModelUi();
    }

    $('#vrm_model_div').show();
}

async function onCharacterRefreshClick() {
    updateCharactersList();
    $('#vrm_character_select').val('none');
    $('#vrm_character_select').trigger('change');
}

async function onCharacterRemoveClick() {
    const character = String($('#vrm_character_select').val());

    if (character == 'none')
        return;

    $('#vrm_model_select').val('none');
    $('#vrm_model_settings').hide();
    delete extension_settings.vrm.character_model_mapping[character];
    saveSettingsDebounced();
    await unloadModel(character);
    console.debug(DEBUG_PREFIX, 'Deleted all settings for', character);
}

async function onModelRefreshClick() {
    updateCharactersModels(true);
    $('#vrm_model_select').val('none');
    $('#vrm_model_select').trigger('change');
}

async function onModelResetClick() {
    const model_path = String($('#vrm_model_select').val());

    if (model_path == "none")
        return;

    const template = `<div class="m-b-1">Are you sure you want to reset all settings of this VRM model?</div>`;
    const confirmation = await callPopup(template, 'confirm');

    if (confirmation) {
        delete extension_settings.vrm.model_settings[model_path];
        $('#vrm_model_select').trigger('change');   
    }
    else {
        console.debug(DEBUG_PREFIX, 'Confirmation refused by user');
    }
}

async function onModelChange() {
    if (!extension_settings.vrm.enabled)
        return;

    const character = String($('#vrm_character_select').val());
    const model_path = String($('#vrm_model_select').val());
    let use_default_settings = false;

    $('#vrm_model_settings').hide();

    if (model_path == 'none') {
        delete extension_settings.vrm.character_model_mapping[character];
        saveSettingsDebounced();
        await unloadModel(character);
        return;
    }

    $('#vrm_model_loading').show();

    extension_settings.vrm.character_model_mapping[character] = model_path;
    saveSettingsDebounced();

        // Initialize new model
    if (extension_settings.vrm.model_settings[model_path] === undefined) {
        use_default_settings = true;
        extension_settings.vrm.model_settings[model_path] = {
            'scale': 3.0,
            'x': 0.0,
            'y': 0.0,
            'z': 0.0,
            'rx': 0.0,
            'ry': 0.0,
            'rz':0.0,
            'animation_default': { 'expression': 'none', 'motion': 'none' },
            //'animation_click': { 'expression': 'none', 'motion': 'none', 'message': '' },
            'classify_mapping': {},
            'hitboxes_mapping': {},
            'blend_shape_mapping': {}
        };

        for (const expression of CLASSIFY_EXPRESSIONS) {
            extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression] = { 'expression': 'none', 'motion': 'none', 'sequence': '' };
        }

        for (const area in HITBOXES) {
            extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][area] = { 'expression': 'none', 'motion': 'none', 'sequence': '', 'message': '' };
        }

        // Initialize default custom expressions
        for (const [exprName, exprConfig] of Object.entries(DEFAULT_CUSTOM_EXPRESSIONS)) {
            extension_settings.vrm.model_settings[model_path]['blend_shape_mapping'][exprName] = {
                blendShapes: { ...exprConfig.blendShapes },
                intensity: exprConfig.intensity
            };
        }

        saveSettingsDebounced();
    } else {
        // Migration: Add sequence field to existing mappings if not present
        for (const expression of CLASSIFY_EXPRESSIONS) {
            if (extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression] !== undefined) {
                if (extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['sequence'] === undefined) {
                    extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['sequence'] = '';
                }
            }
        }
        for (const area in HITBOXES) {
            if (extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][area] !== undefined) {
                if (extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][area]['sequence'] === undefined) {
                    extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][area]['sequence'] = '';
                }
            }
        }
    }

    //await loadScene();
    await setModel(character,model_path);
    await loadModelUi(use_default_settings);
    
    $('#vrm_model_settings').show();
    $('#vrm_model_loading').hide();
}

async function onModelScaleChange() {
    const character = String($('#vrm_character_select').val());
    const model_path = String($('#vrm_model_select').val());
    extension_settings.vrm.model_settings[model_path]['scale'] = Number($('#vrm_model_scale').val());
    $('#vrm_model_scale_value').text(extension_settings.vrm.model_settings[model_path]['scale']);
    saveSettingsDebounced();
    updateModel(character);
}

async function onModelPositionChange() {
    const character = String($('#vrm_character_select').val());
    const model_path = String($('#vrm_model_select').val());
    extension_settings.vrm.model_settings[model_path]['x'] = Number($('#vrm_model_position_x').val());
    extension_settings.vrm.model_settings[model_path]['y'] = Number($('#vrm_model_position_y').val());
    $('#vrm_model_position_x_value').text(extension_settings.vrm.model_settings[model_path]['x']);
    $('#vrm_model_position_y_value').text(extension_settings.vrm.model_settings[model_path]['y']);
    saveSettingsDebounced();
    updateModel(character,);
}

async function onModelRotationChange() {
    const character = String($('#vrm_character_select').val());
    const model_path = String($('#vrm_model_select').val());
    extension_settings.vrm.model_settings[model_path]['rx'] = Number($('#vrm_model_rotation_x').val());
    extension_settings.vrm.model_settings[model_path]['ry'] = Number($('#vrm_model_rotation_y').val());
    $('#vrm_model_rotation_x_value').text(extension_settings.vrm.model_settings[model_path]['rx']);
    $('#vrm_model_rotation_y_value').text(extension_settings.vrm.model_settings[model_path]['ry']);
    saveSettingsDebounced();
    updateModel(character);
}

async function onAnimationMappingChange(type) {
    const character = String($('#vrm_character_select').val());
    const model_path = String($('#vrm_model_select').val());
    let expression;
    let motion;

    switch (type) {
        case 'animation_default':
            expression = $('#vrm_default_expression_select').val();
            motion = $('#vrm_default_motion_select').val();

            extension_settings.vrm.model_settings[model_path]['animation_default']['expression'] = expression;
            extension_settings.vrm.model_settings[model_path]['animation_default']['motion'] = motion;
            console.debug(DEBUG_PREFIX,'Updated animation_default of',character,':',extension_settings.vrm.model_settings[model_path]['animation_default']);
            break;
        default:
            console.error(DEBUG_PREFIX,'Unexpected type:',type);
    }

    saveSettingsDebounced();

    await setExpression(character, expression);
    await setMotion(character, motion, true);
}

async function loadModelUi(use_default_settings) {
    const character = String($('#vrm_character_select').val());
    const model_path = String($('#vrm_model_select').val());
    const expression_ui = $('#vrm_expression_mapping');
    const hiboxes_ui = $('#vrm_hitboxes_mapping');

    expression_ui.empty();
    hiboxes_ui.empty();

    if (model_path == "none")
        return;

    let model = getVRM(character);

    while (model === undefined) { // TODO wait cleaner way
        model = getVRM(character);
        await delay(500);
    }

    console.debug(DEBUG_PREFIX, 'loading settings of model:', model_path);

    let model_expressions = [];
    let model_motions = animations_groups;

    for (const i of Object.keys(model.expressionManager.expressionMap) ?? []) {
        model_expressions.push(i.toLowerCase());
    }

    model_expressions.sort();
    model_motions.sort();

    // Add "none" option
    if (!model_expressions.includes('none')) {
        model_expressions.unshift('none');
    }

    // Initialize default custom expressions BEFORE populating dropdowns
    const availableBlendShapes = [...model_expressions].filter(e => e !== 'none');
    const modelSettings = extension_settings.vrm.model_settings[model_path];
    if (modelSettings && !modelSettings.blend_shape_mapping) {
        modelSettings.blend_shape_mapping = {};
    }
    if (modelSettings && modelSettings.blend_shape_mapping) {
        for (const [defaultExpr, defaultConfig] of Object.entries(DEFAULT_CUSTOM_EXPRESSIONS)) {
            if (!modelSettings.blend_shape_mapping[defaultExpr]) {
                const exprBlendshapes = {};
                for (const blendName of availableBlendShapes) {
                    exprBlendshapes[blendName] = 0;
                }
                modelSettings.blend_shape_mapping[defaultExpr] = {
                    blendShapes: exprBlendshapes,
                    intensity: defaultConfig.intensity || 0.6
                };
            }
        }
        saveSettingsDebounced();
    }

    // Add custom blend shape group names to expressions dropdown
    const blendShapeMapping = modelSettings?.blend_shape_mapping || {};
    for (const groupName in blendShapeMapping) {
        if (!model_expressions.includes(groupName)) {
            model_expressions.push(groupName);
        }
    }

    console.debug(DEBUG_PREFIX, 'expressions:', model_expressions);
    console.debug(DEBUG_PREFIX, 'motions:', model_motions);

    // Model settings
    $('#vrm_model_scale').val(extension_settings.vrm.model_settings[model_path]['scale']);
    $('#vrm_model_scale_value').text(extension_settings.vrm.model_settings[model_path]['scale']);

    $('#vrm_model_position_x').val(extension_settings.vrm.model_settings[model_path]['x']);
    $('#vrm_model_position_x_value').text(extension_settings.vrm.model_settings[model_path]['x']);
    $('#vrm_model_position_y').val(extension_settings.vrm.model_settings[model_path]['y']);
    $('#vrm_model_position_y_value').text(extension_settings.vrm.model_settings[model_path]['y']);

    $('#vrm_model_rotation_x').val(extension_settings.vrm.model_settings[model_path]['rx']);
    $('#vrm_model_rotation_x_value').text(extension_settings.vrm.model_settings[model_path]['rx']);
    $('#vrm_model_rotation_y').val(extension_settings.vrm.model_settings[model_path]['ry']);
    $('#vrm_model_rotation_y_value').text(extension_settings.vrm.model_settings[model_path]['ry']);

	// Hitboxes
    // Hit areas mapping
    for (const hitbox in HITBOXES) {
        hiboxes_ui.append(`
        <div class="vrm-parameter">
            <div class="vrm-parameter-title">
                <label for="vrm_hitbox_${hitbox}">
                ${hitbox}
                </label>
            </div>
            <div>
                <div class="vrm-select-div">
                    <select id="vrm_hitbox_expression_select_${hitbox}">
                    </select>
                    <div id="vrm_hitbox_expression_replay_${hitbox}" class="vrm_replay_button menu_button">
                        <i class="fa-solid fa-arrow-rotate-left"></i>
                    </div>
                </div>
                <div class="vrm-select-div">
                    <select id="vrm_hitbox_motion_select_${hitbox}">
                    </select>
                    <div id="vrm_hitbox_motion_replay_${hitbox}" class="vrm_replay_button menu_button">
                        <i class="fa-solid fa-arrow-rotate-left"></i>
                    </div>
                </div>
                <input type="text" id="vrm_hitbox_sequence_${hitbox}" 
                    placeholder="Sequence: wave,point,wait:500,idle" 
                    style="width: 100%; background-color: #000; color: #fff; border: 1px solid #555; padding: 3px; font-size: 0.9em; margin-bottom: 3px;"
                    title="Optional: Define a sequence of animations instead of a single motion. Format: animation1,animation2,wait:ms,animation3">
                <textarea id="vrm_hitbox_message_${hitbox}" type="text" class="text_pole textarea_compact" rows="2"
            placeholder="Write message te send when clicking the area."></textarea>
            </div>
        </div>
        `);

        loadAnimationUi(
            hitbox,
            use_default_settings,
            model_expressions,
            model_motions,
            `vrm_hitbox_expression_select_${hitbox}`,
            `vrm_hitbox_motion_select_${hitbox}`,
            extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][hitbox]['expression'],
            extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][hitbox]['motion']);

        // Set sequence and message values
        const sequenceValue = extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][hitbox]['sequence'] || '';
        $(`#vrm_hitbox_sequence_${hitbox}`).val(sequenceValue);
        $(`#vrm_hitbox_message_${hitbox}`).val(extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][hitbox]['message']);

        $(`#vrm_hitbox_expression_select_${hitbox}`).on('change', function () { updateHitboxMapping(hitbox); });
        $(`#vrm_hitbox_motion_select_${hitbox}`).on('change', function () { updateHitboxMapping(hitbox); });
        $(`#vrm_hitbox_sequence_${hitbox}`).on('change', function () { updateHitboxMapping(hitbox); });
        $(`#vrm_hitbox_message_${hitbox}`).on('change', function () { updateHitboxMapping(hitbox); });
        $(`#vrm_hitbox_expression_replay_${hitbox}`).on('click', function () { updateHitboxMapping(hitbox); });
        $(`#vrm_hitbox_motion_replay_${hitbox}`).on('click', function () { updateHitboxMapping(hitbox); });

        
        // Default loaded
        if (extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][hitbox]['expression'] != $(`#vrm_hitbox_expression_select_${hitbox}`).val()) {
            extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][hitbox]['expression'] = $(`#vrm_hitbox_expression_select_${hitbox}`).val();
            saveSettingsDebounced();
        }
        
        if (extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][hitbox]['motion'] != $(`#vrm_hitbox_motion_select_${hitbox}`).val()) {
            extension_settings.vrm.model_settings[model_path]['hitboxes_mapping'][hitbox]['motion'] = $(`#vrm_hitbox_motion_select_${hitbox}`).val();
            saveSettingsDebounced();
        }
    }


    // Default expression/motion
    loadAnimationUi(
        "default",
        use_default_settings,
        model_expressions,
        model_motions,
        'vrm_default_expression_select',
        'vrm_default_motion_select',
        extension_settings.vrm.model_settings[model_path]['animation_default']['expression'],
        extension_settings.vrm.model_settings[model_path]['animation_default']['motion']);

    // Default loaded
    if (extension_settings.vrm.model_settings[model_path]['animation_default']['expression'] != $(`#vrm_default_expression_select`).val()) {
        extension_settings.vrm.model_settings[model_path]['animation_default']['expression'] = $(`#vrm_default_expression_select`).val();
        saveSettingsDebounced();
    }
    
    if (extension_settings.vrm.model_settings[model_path]['animation_default']['motion'] != $(`#vrm_default_motion_select`).val()) {
        extension_settings.vrm.model_settings[model_path]['animation_default']['motion'] = $(`#vrm_default_motion_select`).val();
        saveSettingsDebounced();
    }

    // Classify expressions mapping
    for (const expression of CLASSIFY_EXPRESSIONS) {
        expression_ui.append(`
        <div class="vrm-parameter">
            <div class="vrm-parameter-title">
                <label for="vrm_expression_${expression}">
                ${expression}
                </label>
            </div>
            <div>
                <div class="vrm-select-div">
                    <select id="vrm_expression_select_${expression}">
                    </select>
                    <div id="vrm_expression_replay_${expression}" class="vrm_replay_button menu_button">
                        <i class="fa-solid fa-arrow-rotate-left"></i>
                    </div>
                </div>
                <div class="vrm-select-div">
                    <select id="vrm_motion_select_${expression}">
                    </select>
                    <div id="vrm_motion_replay_${expression}" class="vrm_replay_button menu_button">
                        <i class="fa-solid fa-arrow-rotate-left"></i>
                    </div>
                </div>
                <div class="vrm-sequence-input-div">
                    <input type="text" id="vrm_sequence_input_${expression}" 
                        placeholder="Sequence: wave,point,wait:500,idle" 
                        style="width: 100%; background-color: #000; color: #fff; border: 1px solid #555; padding: 3px; font-size: 0.9em;"
                        title="Optional: Define a sequence of animations instead of a single motion. Format: animation1,animation2,wait:ms,animation3">
                </div>
            </div>
        </div>
        `);

        loadAnimationUi(
            expression,
            use_default_settings,
            model_expressions,
            model_motions,
            `vrm_expression_select_${expression}`,
            `vrm_motion_select_${expression}`,
            extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['expression'],
            extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['motion']);

        // Set sequence input value
        const sequenceValue = extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['sequence'] || '';
        $(`#vrm_sequence_input_${expression}`).val(sequenceValue);

        $(`#vrm_expression_select_${expression}`).on('change', function () { updateExpressionMapping(expression); });
        $(`#vrm_motion_select_${expression}`).on('change', function () { updateExpressionMapping(expression); });
        $(`#vrm_expression_replay_${expression}`).on('click', function () { updateExpressionMapping(expression); });
        $(`#vrm_motion_replay_${expression}`).on('click', function () { updateExpressionMapping(expression); });
        $(`#vrm_sequence_input_${expression}`).on('change', function () { updateExpressionMapping(expression); });

        // Default loaded
        if (extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['expression'] != $(`#vrm_expression_select_${expression}`).val()) {
            extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['expression'] = $(`#vrm_expression_select_${expression}`).val();
            saveSettingsDebounced();
        }

        if (extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['motion'] != $(`#vrm_motion_select_${expression}`).val()) {
            extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['motion'] = $(`#vrm_motion_select_${expression}`).val();
            saveSettingsDebounced();
        }
    }

    // Load blend shape mapping UI
    loadBlendShapeMappingUi();
}


async function updateHitboxMapping(hitbox) {
    const character = String($('#vrm_character_select').val());
    const model = String($('#vrm_model_select').val());
    const model_expression = $(`#vrm_hitbox_expression_select_${hitbox}`).val();
    const model_motion = $(`#vrm_hitbox_motion_select_${hitbox}`).val();
    const sequence = $(`#vrm_hitbox_sequence_${hitbox}`).val();
    const message = $(`#vrm_hitbox_message_${hitbox}`).val();

    extension_settings.vrm.model_settings[model]['hitboxes_mapping'][hitbox] = { 'expression': model_expression, 'motion': model_motion, 'sequence': sequence, 'message': message };
    saveSettingsDebounced();

    await setExpression(character, model_expression);
    
    // Play sequence if defined, otherwise play single motion
    if (sequence && sequence.trim()) {
        await setMotionSequence(character, sequence, { loop: false });
    } else {
        await setMotion(character, model_motion, true, true, true);
    }
    console.debug(DEBUG_PREFIX, 'Updated hitbox mapping:', hitbox, extension_settings.vrm.model_settings[model]['hitboxes_mapping'][hitbox]);
}

async function updateExpressionMapping(expression) {
    const character = String($('#vrm_character_select').val());
    const model = String($('#vrm_model_select').val());
    const model_expression = $(`#vrm_expression_select_${expression}`).val();
    const model_motion = $(`#vrm_motion_select_${expression}`).val();
    const sequence = $(`#vrm_sequence_input_${expression}`).val();

    extension_settings.vrm.model_settings[model]['classify_mapping'][expression] = { 'expression': model_expression, 'motion': model_motion, 'sequence': sequence };
    saveSettingsDebounced();

    await setExpression(character, model_expression);

    // If sequence is defined, play it instead of single motion
    if (sequence && sequence.trim()) {
        await setMotionSequence(character, sequence, { loop: false });
    } else {
        await setMotion(character, model_motion, true, true, true);
    }
    console.debug(DEBUG_PREFIX, 'Updated expression mapping:', expression, extension_settings.vrm.model_settings[model]['classify_mapping'][expression]);
}

function updateCharactersList() {
    let current_characters = new Set();
    const context = getContext();
    for (const i of context.characters) {
        current_characters.add(i.name);
    }

    current_characters = Array.from(current_characters);

    if (current_characters.length == 0)
        return;

    let chat_members = currentChatMembers();
    console.debug(DEBUG_PREFIX, 'Chat members', chat_members);

    // Sort group character on top
    for (const i of chat_members) {
        let index = current_characters.indexOf(i);
        if (index != -1) {
            console.debug(DEBUG_PREFIX, 'Moving to top', i);
            current_characters.splice(index, 1);
        }
    }

    current_characters = chat_members;

    if (JSON.stringify(characters_list) !== JSON.stringify(current_characters)) {
        characters_list = current_characters;

        $('#vrm_character_select')
            .find('option')
            .remove()
            .end()
            .append('<option value="none">Select Character</option>')
            .val('none');

        for (const charName of characters_list) {
            $('#vrm_character_select').append(new Option(charName, charName));
        }

        console.debug(DEBUG_PREFIX, 'Updated character list to:', characters_list);
    }
}

async function updateCharactersModels(refreshButton = false) {
    const context = getContext();
    let chat_members = currentChatMembers();

    console.debug(DEBUG_PREFIX, 'Updating models mapping');

    // Assets folder models
    const assets = await getAssetsVRMFiles();

    console.debug(DEBUG_PREFIX, 'Models from assets folder:',assets['vrm']['model']);

    if (refreshButton || models_files.length == 0) {
        models_files = [];
        models_files_label = [];
        for (const entry of assets['vrm']['model']) {
            let label = entry.replaceAll('\\', '/').replace(".vrm","");
            label = label.substring(label.lastIndexOf('/')+1);
            models_files.push(entry);
            models_files_label.push([label,entry]);
        }
        console.debug(DEBUG_PREFIX, 'Updated models list');
    }

    animations_files = assets['vrm']['animation'];
    for(const i in animations_files) {
        animations_files[i] = animations_files[i].toLowerCase();
        const animation_group_name = animations_files[i].replace(/\.[^/.]+$/, "").replace(/\d+$/, "");
        if (!animations_groups.includes(animation_group_name))
            animations_groups.push(animation_group_name);
    }

    console.debug(DEBUG_PREFIX, 'Updated models to:', models_files, animations_files);
    $('#vrm_character_select').trigger('change');
}

async function updateCharactersListOnce() {
    console.debug(DEBUG_PREFIX, 'UDPATING char list', characters_list);
    while (characters_list.length == 0) {
        console.debug(DEBUG_PREFIX, 'UDPATING char list');
        updateCharactersList();
        await delay(1000);
    }
}

//#############################//
//  Animation Sequence UI      //
//#############################//

async function onSequencePlayClick() {
    const sequenceInput = $('#vrm_sequence_input').val().trim();
    const loop = $('#vrm_sequence_loop').is(':checked');
    
    if (!sequenceInput) {
        console.warn(DEBUG_PREFIX, 'No sequence entered');
        return;
    }
    
    const character = $('#vrm_character_select').val();
    if (!character || character === 'none') {
        console.warn(DEBUG_PREFIX, 'No character selected for sequence playback');
        return;
    }
    
    console.debug(DEBUG_PREFIX, 'Playing sequence for character:', character, 'sequence:', sequenceInput, 'loop:', loop);
    await setMotionSequence(character, sequenceInput, { loop });
}

async function onSequenceClearClick() {
    const character = $('#vrm_character_select').val();
    if (!character || character === 'none') {
        console.warn(DEBUG_PREFIX, 'No character selected for sequence clear');
        return;
    }
    
    console.debug(DEBUG_PREFIX, 'Clearing sequence for character:', character);
    clearAnimationSequence(character);
}

//#############################//
//  Blend Shape Mapping UI      //
//#############################//

function loadBlendShapeMappingUi() {
    const character = String($('#vrm_character_select').val());
    const model_path = String($('#vrm_model_select').val());
    const blendShapeGroupsContainer = $('#vrm_blend_shape_groups');

    blendShapeGroupsContainer.empty();

    if (model_path === 'none') return;

    let model = getVRM(character);

    if (!model) {
        setTimeout(() => loadBlendShapeMappingUi(), 500);
        return;
    }

    const availableBlendShapes = [];
    const expressionMap = model.expressionManager?.expressionMap || {};
    for (const expressionName in expressionMap) {
        availableBlendShapes.push(expressionName);
    }
    availableBlendShapes.sort();

    const modelSettings = extension_settings.vrm.model_settings[model_path];
    const updatedBlendShapeMapping = (modelSettings?.blend_shape_mapping) || {};

    for (const groupName in updatedBlendShapeMapping) {
        const group = updatedBlendShapeMapping[groupName];
        const isDefault = !!DEFAULT_CUSTOM_EXPRESSIONS[groupName];

        const html = `
            <div class="vrm-parameter" id="vrm_blend_shape_group_${groupName}">
                <div class="vrm-parameter-title" style="display: flex; justify-content: space-between; align-items: center;">
                    <label>${groupName}</label>
                    ${isDefault ? '<span style="font-size: 0.7em; color: #888;">(default)</span>' : ''}
                    <button class="menu_button vrm_blend_shape_delete" data-group="${groupName}" style="padding: 2px 8px; font-size: 0.8em;">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
                <div class="vrm-blend-shape-weights">
                    ${availableBlendShapes.map(blendName => {
                        const weight = group.blendShapes?.[blendName] ?? 0;
                        return `
                            <div style="display: flex; align-items: center; margin-bottom: 6px;">
                                <label style="flex: 1; font-size: 0.9em;">${blendName}</label>
                                <input type="range" class="vrm_blend_shape_weight" data-group="${groupName}" data-blend="${blendName}" min="0" max="1" step="0.1" value="${weight}" style="width: 60%;">
                                <span style="width: 35px; text-align: right; font-size: 0.85em;">${weight.toFixed(1)}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
                <div style="margin-top: 8px;">
                    <label>Intensity: <span class="vrm_blend_shape_intensity_value">${group.intensity || 1.0}</span></label>
                    <input type="range" class="vrm_blend_shape_intensity" data-group="${groupName}" min="0" max="1" step="0.1" value="${group.intensity || 1.0}" style="width: 100%;">
                </div>
                <button class="menu_button vrm_blend_shape_test" data-group="${groupName}" style="width: 100%; margin-top: 8px;">Test</button>
            </div>
        `;

        blendShapeGroupsContainer.append(html);
    }

    // Weight slider handlers
    blendShapeGroupsContainer.find('.vrm_blend_shape_weight').off('input').on('input', function() {
        const blendName = $(this).data('blend');
        const groupN = $(this).data('group');
        const value = parseFloat($(this).val());
        $(this).next().text(value.toFixed(1));

        if (!extension_settings.vrm.model_settings[model_path].blend_shape_mapping[groupN].blendShapes) {
            extension_settings.vrm.model_settings[model_path].blend_shape_mapping[groupN].blendShapes = {};
        }
        extension_settings.vrm.model_settings[model_path].blend_shape_mapping[groupN].blendShapes[blendName] = value;
        saveSettingsDebounced();
    });

    // Intensity slider handler
    blendShapeGroupsContainer.find('.vrm_blend_shape_intensity').off('input').on('input', function() {
        const groupN = $(this).data('group');
        const value = parseFloat($(this).val());
        $(this).prev().find('.vrm_blend_shape_intensity_value').text(value.toFixed(1));
        extension_settings.vrm.model_settings[model_path].blend_shape_mapping[groupN].intensity = value;
        saveSettingsDebounced();
    });

    // Delete button handler
    blendShapeGroupsContainer.find('.vrm_blend_shape_delete').off('click').on('click', async function() {
        const groupN = $(this).data('group');
        if (DEFAULT_CUSTOM_EXPRESSIONS[groupN]) {
            // Reset to defaults
            const defaultConfig = DEFAULT_CUSTOM_EXPRESSIONS[groupN];
            const exprBlendshapes = {};
            for (const blendName of availableBlendShapes) {
                exprBlendshapes[blendName] = 0;
            }
            extension_settings.vrm.model_settings[model_path].blend_shape_mapping[groupN].blendShapes = exprBlendshapes;
            extension_settings.vrm.model_settings[model_path].blend_shape_mapping[groupN].intensity = defaultConfig.intensity || 1.0;
            saveSettingsDebounced();
            loadBlendShapeMappingUi();
        } else {
            delete extension_settings.vrm.model_settings[model_path].blend_shape_mapping[groupN];
            saveSettingsDebounced();
            loadBlendShapeMappingUi();
            await loadModelUi(false);
        }
    });

    // Test button handler
    blendShapeGroupsContainer.find('.vrm_blend_shape_test').off('click').on('click', async function() {
        const groupN = $(this).data('group');
        await setExpression(character, groupN);
    });
}

async function onBlendShapeAddClick() {
    const character = String($('#vrm_character_select').val());
    const model_path = String($('#vrm_model_select').val());
    const groupName = $('#vrm_blend_shape_group_name').val().trim();

    if (!groupName) {
        console.warn(DEBUG_PREFIX, 'No blend shape group name provided');
        return;
    }

    if (!extension_settings.vrm.model_settings[model_path].blend_shape_mapping) {
        extension_settings.vrm.model_settings[model_path].blend_shape_mapping = {};
    }

    if (extension_settings.vrm.model_settings[model_path].blend_shape_mapping[groupName]) {
        console.warn(DEBUG_PREFIX, 'Blend shape group already exists:', groupName);
        return;
    }

    extension_settings.vrm.model_settings[model_path].blend_shape_mapping[groupName] = {
        blendShapes: {},
        intensity: 1.0
    };

    saveSettingsDebounced();
    $('#vrm_blend_shape_group_name').val('');
    loadBlendShapeMappingUi();

    // Reload model UI to update expression dropdowns with new blend shape group
    await loadModelUi(false);
}

//#############################//
//  API Calls                  //
//#############################//

async function getAssetsVRMFiles() {
    console.debug(DEBUG_PREFIX, 'getting vrm model json file from assets folder');

    try {
        const result = await fetch('/api/assets/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ folder: VRM_MODEL_FOLDER })
        });
        let files = result.ok ? (await result.json()) : [];
        return files;
    }
    catch (err) {
        console.log(err);
        return [];
    }
}
